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

    console.log("Checkout schema migration completed successfully.");
  } catch (error) {
    console.error("Checkout schema migration failed:", error.code || "UNKNOWN", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) await connection.end();
  }
}

main();
