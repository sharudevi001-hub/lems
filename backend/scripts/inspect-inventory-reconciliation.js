require("dotenv").config();
const mysql = require("mysql2/promise");

const config = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  user: process.env.MYSQLUSER || process.env.DB_USER || "root",
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || "lems_db",
  connectTimeout: 10000,
  multipleStatements: false
};

// Read-only inventory reconciliation report. This script deliberately contains
// SELECT statements only: it does not alter, insert, update, or delete production data.
async function tableExists(db, table) {
  const [rows] = await db.execute(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
    [config.database, table]
  );
  return rows.length > 0;
}

async function columnsFor(db, table) {
  const [rows] = await db.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    [config.database, table]
  );
  return rows.map(row => row.COLUMN_NAME);
}

async function main() {
  let db;
  try {
    db = await mysql.createConnection(config);
    const [databaseRows] = await db.execute("SELECT DATABASE() AS database_name");
    if (!databaseRows[0]?.database_name) throw new Error("No database selected; check MYSQLDATABASE/DB_NAME.");

    for (const table of ["equipment", "transactions", "complaints", "users"]) {
      if (!(await tableExists(db, table))) throw new Error("Required table is missing: " + table);
    }

    const equipmentColumns = await columnsFor(db, "equipment");
    const transactionColumns = await columnsFor(db, "transactions");
    const complaintColumns = await columnsFor(db, "complaints");
    const userColumns = await columnsFor(db, "users");

    const equipmentSelect = ["equipment_id", "equipment_code", "name", "category", "status",
      "total_quantity", "available_quantity", "qr_token"].filter(c => equipmentColumns.includes(c));
    const transactionSelect = ["transaction_id", "user_id", "equipment_id", "checkout_date",
      "return_date", "status", "checkout_request_id"].filter(c => transactionColumns.includes(c));
    const complaintSelect = ["complaint_id", "user_id", "equipment_id", "issue_description",
      "status", "created_at", "updated_at"].filter(c => complaintColumns.includes(c));
    const userSelect = ["user_id", "student_id", "name", "full_name", "email"].filter(c => userColumns.includes(c));

    const [equipment] = await db.query(
      "SELECT " + equipmentSelect.map(c => "`" + c + "`").join(", ") +
      " FROM equipment ORDER BY equipment_id"
    );
    const [transactions] = await db.query(
      "SELECT " + transactionSelect.map(c => "t.`" + c + "`").join(", ") +
      (userSelect.length ? ", " + userSelect.filter(c => c !== "user_id").map(c => "u.`" + c + "` AS user_" + c).join(", ") : "") +
      " FROM transactions t LEFT JOIN users u ON u.user_id = t.user_id ORDER BY t.transaction_id"
    );
    const [complaints] = await db.query(
      "SELECT " + complaintSelect.map(c => "c.`" + c + "`").join(", ") +
      " FROM complaints c ORDER BY c.complaint_id"
    );

    const aggregateRows = equipment.filter(row =>
      Number(row.total_quantity ?? 1) > 1 || Number(row.available_quantity ?? 1) > 1
    );
    const duplicateActiveLoans = Object.values(transactions
      .filter(row => row.status === "ACTIVE")
      .reduce((groups, row) => {
        const key = String(row.equipment_id);
        (groups[key] ||= []).push(row);
        return groups;
      }, {}))
      .filter(group => group.length > 1);
    const openComplaints = complaints.filter(row => !["RESOLVED", "REJECTED"].includes(row.status));

    console.log(JSON.stringify({
      report_type: "READ_ONLY_LEMS_INVENTORY_RECONCILIATION",
      generated_at: new Date().toISOString(),
      database: databaseRows[0].database_name,
      safety: "SELECT-only report; no database rows or schema were changed.",
      summary: {
        equipment_rows: equipment.length,
        aggregate_stock_rows: aggregateRows.length,
        active_transactions: transactions.filter(row => row.status === "ACTIVE").length,
        equipment_with_multiple_active_loans: duplicateActiveLoans.length,
        open_complaints: openComplaints.length
      },
      aggregate_stock_rows: aggregateRows,
      duplicate_active_loans: duplicateActiveLoans,
      open_complaints: openComplaints,
      equipment: equipment,
      transactions: transactions
    }, null, 2));
  } catch (error) {
    console.error("Read-only reconciliation report failed:", error.code || "UNKNOWN", error.message);
    process.exitCode = 1;
  } finally {
    if (db) await db.end();
  }
}

main();
