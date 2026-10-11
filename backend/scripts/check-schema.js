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
const required = {
    users: ["user_id", "name", "student_id", "email", "password", "role", "reset_token", "reset_token_expires"],
    equipment: ["equipment_id", "equipment_code", "name", "category", "rfid_tag", "status", "runtime_hours", "calibration_limit", "total_quantity", "available_quantity"],
    transactions: ["transaction_id", "user_id", "equipment_id", "checkout_time", "return_time", "status"],
    complaints: ["complaint_id", "user_id", "equipment_id", "issue_description", "status", "created_at"]
};

async function main() {
    let connection;
    try {
        connection = await mysql.createConnection(config);
        const [rows] = await connection.execute(
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION",
            [config.database]
        );
        const byTable = new Map();
        for (const row of rows) {
            if (!byTable.has(row.TABLE_NAME)) byTable.set(row.TABLE_NAME, new Set());
            byTable.get(row.TABLE_NAME).add(row.COLUMN_NAME);
        }
        let missingCount = 0;
        console.log("LEMS schema check (read-only)");
        console.log("Database:", config.database);
        console.log("This script does not create tables or change records.\n");
        for (const [table, columns] of Object.entries(required)) {
            const present = byTable.get(table);
            if (!present) {
                console.log("[MISSING TABLE] " + table);
                missingCount += columns.length;
                continue;
            }
            const missing = columns.filter(column => !present.has(column));
            if (!missing.length) console.log("[OK] " + table + " (" + columns.length + " checked columns)");
            else {
                console.log("[MISSING COLUMNS] " + table + ": " + missing.join(", "));
                missingCount += missing.length;
            }
        }
        if (missingCount) {
            console.error("\nSchema is not ready. Back up the database, compare it with the local schema, then apply reviewed migrations.");
            process.exitCode = 2;
        } else {
            console.log("\nAll columns required by the current LEMS API were found.");
        }
    } catch (error) {
        console.error("Schema check could not complete:", error.message);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}
main();
