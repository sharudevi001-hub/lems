require("dotenv").config();
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");

const studentId = String(process.env.ADMIN_STUDENT_ID || "").trim();
const newPassword = String(process.env.ADMIN_NEW_PASSWORD || "");
const config = {
    host: process.env.MYSQLHOST || process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    user: process.env.MYSQLUSER || process.env.DB_USER || "root",
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || "lems_db",
    connectTimeout: 10000
};

async function main() {
    if (!studentId || !newPassword) {
        throw new Error("Set ADMIN_STUDENT_ID and ADMIN_NEW_PASSWORD for an existing user. No default credentials are created.");
    }
    if (newPassword.length < 12 || newPassword.length > 128) {
        throw new Error("ADMIN_NEW_PASSWORD must be 12-128 characters.");
    }
    const connection = await mysql.createConnection(config);
    try {
        const [users] = await connection.execute(
            "SELECT user_id FROM users WHERE student_id = ? LIMIT 2",
            [studentId]
        );
        if (users.length !== 1) {
            throw new Error(users.length === 0
                ? "No user found with that student ID. Import users or create the account first."
                : "More than one user matched that student ID; stop and resolve duplicate records.");
        }
        const hash = await bcrypt.hash(newPassword, 12);
        await connection.execute(
            "UPDATE users SET role = 'admin', password = ? WHERE user_id = ?",
            [hash, users[0].user_id]
        );
        console.log("Administrator role and password updated for the requested existing account.");
        console.log("The password itself was not printed.");
    } finally {
        await connection.end();
    }
}
main().catch(error => {
    console.error("Administrator provisioning failed:", error.message);
    process.exitCode = 1;
});
