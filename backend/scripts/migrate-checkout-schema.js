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

    // RFID is optional for physical units until an RFID sticker is assigned.
    // Preserve the existing column type/length and unique index while allowing NULL.
    const [rfidColumns] = await connection.execute(
      "SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'equipment' AND COLUMN_NAME = 'rfid_tag' LIMIT 1",
      [config.database]
    );
    if (!rfidColumns.length) throw new Error("Required column equipment.rfid_tag is missing.");
    if (rfidColumns[0].IS_NULLABLE !== "YES") {
      const safeType = String(rfidColumns[0].COLUMN_TYPE || "").toUpperCase();
      if (!/^(VARCHAR|CHAR)\\(\\d+\\)$/.test(safeType)) throw new Error("Unsupported equipment.rfid_tag type; manual review is required before making RFID optional.");
      await connection.query("ALTER TABLE equipment MODIFY COLUMN rfid_tag " + safeType + " NULL");
      console.log("Made equipment.rfid_tag optional; RFID can be linked after unit creation.");
    } else console.log("equipment.rfid_tag already allows NULL");

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
