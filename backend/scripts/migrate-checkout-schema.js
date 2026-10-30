require("dotenv").config();
const mysql = require("mysql2/promise");

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "lems_db",
  connectTimeout: 10000
};

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1",
    [config.database, table, column]
  );
  return rows.length > 0;
}

async function indexExists(connection, table, index) {
  const [rows] = await connection.execute(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1",
    [config.database, table, index]
  );
  return rows.length > 0;
}

async function main() {
  let connection;
  try {
    connection = await mysql.createConnection(config);
    const [dbRows] = await connection.execute("SELECT DATABASE() AS database_name");
    if (!dbRows[0] || !dbRows[0].database_name) throw new Error("No database selected; check MYSQLDATABASE/DB_NAME.");
    const [tables] = await connection.execute(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('transactions', 'checkout_request_items')",
      [config.database]
    );
    const tableNames = new Set(tables.map(row => row.TABLE_NAME));
    for (const requiredTable of ["transactions", "checkout_request_items"]) {
      if (!tableNames.has(requiredTable)) throw new Error("Required table is missing: " + requiredTable + ". Apply the base LEMS migrations first.");
    }

    // Reconcile legacy quantity-based stock into one row per physical unit.
    // Keep each original equipment_id so existing transactions, checkout requests,
    // and condition reports remain attached to a real unit. Additional units get
    // fresh codes and QR tokens. This is idempotent: rows are split only while
    // total_quantity > 1, and each successful split sets the original to quantity 1.
    const hasTotalQuantityForSplit = await columnExists(connection, "equipment", "total_quantity");
    const hasAvailableQuantityForSplit = await columnExists(connection, "equipment", "available_quantity");
    if (hasTotalQuantityForSplit && hasAvailableQuantityForSplit) {
      const [legacyRows] = await connection.query(
        "SELECT equipment_id, equipment_code, name, category, rfid_tag, status, runtime_hours, calibration_limit, total_quantity, available_quantity, qr_token " +
        "FROM equipment WHERE COALESCE(total_quantity,1) > 1 ORDER BY equipment_id"
      );
      for (const row of legacyRows) {
        const total = Number(row.total_quantity || 1);
        const available = Number(row.available_quantity || 0);
        if (!Number.isInteger(total) || total < 1 || available < 0 || available > total) {
          throw new Error("Invalid stock quantities for equipment_id=" + row.equipment_id + "; refusing to split.");
        }
        const [activeLoans] = await connection.execute(
          "SELECT transaction_id FROM transactions WHERE equipment_id = ? AND status = 'ACTIVE' ORDER BY transaction_id",
          [row.equipment_id]
        );
        if (activeLoans.length > 1 || activeLoans.length > (total - available)) {
          throw new Error("Cannot safely split equipment_id=" + row.equipment_id + ": active loan count does not match checked-out quantity.");
        }
        // An aggregate row cannot identify which historic loan maps to which unit.
        // Keep the original row for its active loan when one exists; clones are free units.
        const [requestItems] = await connection.execute(
          "SELECT request_item_id, request_id, COALESCE(quantity,1) AS quantity FROM checkout_request_items WHERE equipment_id = ? ORDER BY request_item_id",
          [row.equipment_id]
        );
        const requestedUnits = requestItems.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
        if (requestedUnits > total) {
          throw new Error("Cannot safely split equipment_id=" + row.equipment_id + ": checkout requests ask for " + requestedUnits + " units but stock has only " + total + ".");
        }
        const newUnitIds = [];
        for (let unit = 1; unit < total; unit++) {
          const code = String(row.equipment_code || ("LEMS-" + row.equipment_id)) + "-U" + String(unit + 1).padStart(3, "0");
          const qr = require("crypto").randomBytes(16).toString("hex");
          const [insertResult] = await connection.execute(
            "INSERT INTO equipment (equipment_code,name,category,rfid_tag,status,runtime_hours,calibration_limit,total_quantity,available_quantity,qr_token) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            [code, row.name, row.category, "LEGACY-" + row.equipment_id + "-" + unit, "AVAILABLE", row.runtime_hours || 0, row.calibration_limit || 500, 1, 1, qr]
          );
          newUnitIds.push(insertResult.insertId);
        }
        // Preserve every requested unit while converting aggregate request quantities
        // into one request-item row per physical equipment ID.
        let nextUnitIndex = 0;
        for (const item of requestItems) {
          const quantity = Number(item.quantity || 1);
          if (quantity > 1) {
            await connection.execute(
              "UPDATE checkout_request_items SET quantity = 1 WHERE request_item_id = ?",
              [item.request_item_id]
            );
            for (let copy = 1; copy < quantity; copy++) {
              const unitId = newUnitIds[nextUnitIndex++];
              if (!unitId) throw new Error("Not enough split units to expand checkout request " + item.request_id + ".");
              await connection.execute(
                "INSERT INTO checkout_request_items (request_id,equipment_id,quantity) VALUES (?,?,1)",
                [item.request_id, unitId]
              );
            }
          }
        }
        const hasActiveLoan = activeLoans.length > 0;
        await connection.execute(
          "UPDATE equipment SET total_quantity=1, available_quantity=?, status=? WHERE equipment_id=?",
          [hasActiveLoan ? 0 : 1, hasActiveLoan ? "IN_USE" : (row.status === "MAINTENANCE" ? "MAINTENANCE" : "AVAILABLE"), row.equipment_id]
        );
        console.log("Split equipment " + row.equipment_code + " into " + total + " individual unit rows; original ID preserved.");
      }
    }

    // Safety preflight: never enable per-physical-unit checkout while a row still
    // represents multiple stock units, or while multiple active loans point at one row.
    // Run this before the first DDL statement because MySQL DDL auto-commits.
    const [equipmentTableRows] = await connection.execute(
      "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'equipment' LIMIT 1",
      [config.database]
    );
    if (!equipmentTableRows.length) throw new Error("Required table is missing: equipment.");

    const hasTotalQuantity = await columnExists(connection, "equipment", "total_quantity");
    const hasAvailableQuantity = await columnExists(connection, "equipment", "available_quantity");
    if (hasTotalQuantity || hasAvailableQuantity) {
      const aggregateConditions = [];
      if (hasTotalQuantity) aggregateConditions.push("COALESCE(total_quantity, 1) > 1");
      if (hasAvailableQuantity) aggregateConditions.push("COALESCE(available_quantity, 1) > 1");
      const [aggregateRows] = await connection.query(
        "SELECT equipment_id, equipment_code, " +
        (hasTotalQuantity ? "total_quantity" : "NULL AS total_quantity") + ", " +
        (hasAvailableQuantity ? "available_quantity" : "NULL AS available_quantity") +
        " FROM equipment WHERE " + aggregateConditions.join(" OR ") + " LIMIT 10"
      );
      if (aggregateRows.length) {
        const sample = aggregateRows.map(row =>
          String(row.equipment_code || row.equipment_id) +
          " (total=" + String(row.total_quantity) +
          ", available=" + String(row.available_quantity) + ")"
        ).join(", ");
        throw new Error(
          "Migration stopped before changing the database: aggregate stock rows were found (" +
          sample + "). Split and reconcile each physical unit and its active transaction history first."
        );
      }
    }

    const [duplicateActiveLoans] = await connection.query(
      "SELECT equipment_id, COUNT(*) AS active_count FROM transactions " +
      "WHERE status = 'ACTIVE' GROUP BY equipment_id HAVING COUNT(*) > 1 LIMIT 10"
    );
    if (duplicateActiveLoans.length) {
      const sample = duplicateActiveLoans.map(row =>
        "equipment_id=" + row.equipment_id + " active_loans=" + row.active_count
      ).join(", ");
      throw new Error(
        "Migration stopped before changing the database: multiple active loans reference the same equipment row (" +
        sample + "). Reconcile physical-unit assignments before proceeding."
      );
    }
    console.log("Inventory preflight passed: no aggregate stock rows or duplicate active loans found.");

    // Repair core columns expected by the current equipment and student APIs.
    // All changes are conditional and preserve existing inventory and student rows.
    for (const [column, definition] of [
      ["qr_token", "CHAR(32) NULL"],
      ["total_quantity", "INT UNSIGNED NOT NULL DEFAULT 1"],
      ["available_quantity", "INT UNSIGNED NOT NULL DEFAULT 1"]
    ]) {
      if (!(await columnExists(connection, "equipment", column))) {
        await connection.query("ALTER TABLE equipment ADD COLUMN " + column + " " + definition);
        console.log("Added equipment." + column);
      } else console.log("equipment." + column + " already exists");
    }

    // Keep the legacy card column only for old-row compatibility. It must be nullable,
    // otherwise QR-only inserts that intentionally omit it fail on older databases.
    // No card identifier is generated, read, or written by the application.
    const [legacyCardColumns] = await connection.execute(
      "SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'equipment' AND COLUMN_NAME = 'rfid_tag' LIMIT 1",
      [config.database]
    );
    if (legacyCardColumns.length && legacyCardColumns[0].IS_NULLABLE === "NO") {
      const legacyType = String(legacyCardColumns[0].COLUMN_TYPE || "").trim();
      if (!/^[a-zA-Z0-9_(),' ]+$/.test(legacyType)) throw new Error("Unexpected legacy equipment.rfid_tag column type; refusing automatic schema change.");
      await connection.query("ALTER TABLE equipment MODIFY COLUMN rfid_tag " + legacyType + " NULL");
      console.log("Made legacy equipment.rfid_tag nullable; QR-only application does not use it.");
    }

    if (await columnExists(connection, "equipment", "qr_token")) {
      await connection.query("UPDATE equipment SET qr_token = REPLACE(UUID(), '-', '') WHERE qr_token IS NULL OR qr_token = ''");
      if (!(await indexExists(connection, "equipment", "uq_equipment_qr_token"))) {
        await connection.query("CREATE UNIQUE INDEX uq_equipment_qr_token ON equipment (qr_token)");
        console.log("Added equipment QR token index");
      }
    }

    for (const [column, definition] of [
      ["department", "VARCHAR(100) NULL"],
      ["academic_year", "VARCHAR(20) NULL"],
      ["section", "VARCHAR(20) NULL"],
      ["account_status", "ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'"]
    ]) {
      if (!(await columnExists(connection, "users", column))) {
        await connection.query("ALTER TABLE users ADD COLUMN " + column + " " + definition);
        console.log("Added users." + column);
      } else console.log("users." + column + " already exists");
    }

    if (!(await columnExists(connection, "transactions", "checkout_request_id"))) {
      await connection.query("ALTER TABLE transactions ADD COLUMN checkout_request_id BIGINT UNSIGNED NULL");
      console.log("Added transactions.checkout_request_id");
    } else console.log("transactions.checkout_request_id already exists");

    if (!(await columnExists(connection, "checkout_request_items", "quantity"))) {
      await connection.query("ALTER TABLE checkout_request_items ADD COLUMN quantity INT UNSIGNED NOT NULL DEFAULT 1");
      console.log("Added checkout_request_items.quantity");
    } else console.log("checkout_request_items.quantity already exists");

    if (!(await indexExists(connection, "transactions", "idx_transactions_checkout_request_id"))) {
      await connection.query("CREATE INDEX idx_transactions_checkout_request_id ON transactions (checkout_request_id)");
      console.log("Added idx_transactions_checkout_request_id");
    } else console.log("Checkout request index already exists");

    // Create return QR tables independently of the older, non-idempotent SQL migration.
    // These CREATE TABLE statements preserve all existing rows and are safe to rerun.
    await connection.query(`
      CREATE TABLE IF NOT EXISTS return_sessions (
        return_session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        token_hash CHAR(64) NOT NULL,
        status ENUM('PENDING','CONFIRMED','CANCELLED') NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP NULL,
        confirmed_by INT NULL,
        PRIMARY KEY (return_session_id),
        UNIQUE KEY uq_return_sessions_token_hash (token_hash),
        KEY idx_return_sessions_user_status (user_id,status),
        CONSTRAINT fk_return_sessions_user FOREIGN KEY (user_id) REFERENCES users(user_id),
        CONSTRAINT fk_return_sessions_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(user_id)
      ) ENGINE=InnoDB
    `);
    console.log("Return QR sessions table is ready.");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS return_session_items (
        return_session_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        return_session_id BIGINT UNSIGNED NOT NULL,
        transaction_id INT NOT NULL,
        condition_status ENUM('GOOD','DAMAGED','MISSING_PARTS') NULL,
        condition_notes VARCHAR(1000) NULL,
        processed_at TIMESTAMP NULL,
        PRIMARY KEY (return_session_item_id),
        UNIQUE KEY uq_return_session_transaction (return_session_id,transaction_id),
        KEY idx_return_session_items_transaction (transaction_id),
        CONSTRAINT fk_return_session_items_session FOREIGN KEY (return_session_id) REFERENCES return_sessions(return_session_id) ON DELETE CASCADE,
        CONSTRAINT fk_return_session_items_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
      ) ENGINE=InnoDB
    `);
    console.log("Return QR item table is ready.");

    await connection.query(`
      CREATE TABLE IF NOT EXISTS equipment_condition_reports (
        condition_report_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        transaction_id INT NOT NULL,
        equipment_id INT NOT NULL,
        user_id INT NOT NULL,
        return_session_id BIGINT UNSIGNED NULL,
        condition_status ENUM('GOOD','DAMAGED','MISSING_PARTS') NOT NULL,
        notes VARCHAR(1000) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (condition_report_id),
        KEY idx_condition_equipment_created (equipment_id,created_at),
        CONSTRAINT fk_condition_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
        CONSTRAINT fk_condition_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(equipment_id),
        CONSTRAINT fk_condition_user FOREIGN KEY (user_id) REFERENCES users(user_id),
        CONSTRAINT fk_condition_return_session FOREIGN KEY (return_session_id) REFERENCES return_sessions(return_session_id)
      ) ENGINE=InnoDB
    `);
    console.log("Equipment condition report table is ready.");

    console.log("Checkout schema migration completed successfully.");
  } catch (error) {
    console.error("Checkout schema migration failed:", error.code || "UNKNOWN", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

main();
