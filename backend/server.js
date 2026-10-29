
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
    ...(process.env.APP_BASE_URL ? [process.env.APP_BASE_URL.replace(/\/+$/, "")] : []),
    ...(process.env.CORS_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean)
]);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Kiosk-Key"]
}));
app.use(express.json({ limit: "1mb" }));

// Nodemailer Gmail Setup
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";

let transporter = null;

if (EMAIL_USER && EMAIL_PASS && EMAIL_USER !== "your-gmail@gmail.com") {
    transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log("Nodemailer Gmail Transporter configured for:", EMAIL_USER);
}

// Use Railway's MySQL variables; schema migrations must be run separately.
const db = mysql.createPool({
    host: process.env.MYSQLHOST || process.env.DB_HOST || "127.0.0.1",
    user: process.env.MYSQLUSER || process.env.DB_USER || "root",
    password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || "",
    database: process.env.MYSQLDATABASE || process.env.DB_NAME || "lems_db",
    port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0
});
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "local-development-only-change-this-secret");
if (!JWT_SECRET) throw new Error("JWT_SECRET must be configured in production.");
if (process.env.NODE_ENV !== "production" && !process.env.JWT_SECRET) console.warn("Using a development-only JWT secret.");
const FRONTEND_DIST = path.join(__dirname, "..", "frontend-react", "dist");

db.getConnection((err, connection) => {
    if (err) {
        console.error("MySQL connection failed. Check the MYSQL* environment variables:", err.message);
        return;
    }
    connection.release();
    console.log("MySQL connection established.");
});

const authenticateToken = (req, res, next) => {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ message: "Please sign in to continue." });
    jwt.verify(token, JWT_SECRET, { issuer: "lems-api", audience: "lems-app" }, (err, payload) => {
        if (err) return res.status(401).json({ message: "Session expired or invalid. Please sign in again." });
        req.user = payload;
        next();
    });
};
const requireAdmin = (req, res, next) => {
    if (!req.user || String(req.user.role || "").toLowerCase() !== "admin") {
        return res.status(403).json({ message: "Administrator access is required." });
    }
    next();
};
const verifyKioskKey = (req, res, next) => {
    const expected = process.env.KIOSK_API_KEY;
    if (!expected) return res.status(503).json({ message: "Kiosk integration is not enabled." });
    if ((req.get("x-kiosk-key") || "") !== expected) return res.status(401).json({ message: "Invalid kiosk credentials." });
    next();
};
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Too many attempts. Please try again later." }
});

// Home API
app.get("/", (req, res) => {
    const indexPath = path.join(FRONTEND_DIST, "index.html");
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.send("LEMS Backend API is running. Build the React frontend to serve the web app.");
});

app.get("/health", (req, res) => {
    db.query("SELECT 1 AS ok", (error) => {
        if (error) return res.status(503).json({ status: "degraded", database: "unavailable" });
        res.json({ status: "ok", database: "connected" });
    });
});

// Resolve an opaque equipment QR token after the user is authenticated.
app.get("/api/equipment/qr/:token", authenticateToken, (req, res) => {
    const token = String(req.params.token || "").trim();
    if (!/^[a-f0-9]{32}$/i.test(token)) return res.status(400).json({ message: "Invalid equipment QR token." });
    db.query("SELECT equipment_id, equipment_code, name, category, status, COALESCE(available_quantity,1) AS available_quantity, COALESCE(total_quantity,1) AS total_quantity FROM equipment WHERE qr_token = ? LIMIT 1", [token], (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not resolve equipment QR. Apply the reviewed equipment QR migration first." });
        if (!rows.length) return res.status(404).json({ message: "Equipment QR was not found." });
        res.json({ equipment: rows[0] });
    });
});

// Get all equipment
app.get("/api/equipment", authenticateToken, (req, res) => {
    db.query("SELECT * FROM equipment", (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        res.json(results);
    });
});

app.put("/api/equipment/:id", authenticateToken, requireAdmin, (req, res) => {
    const { id } = req.params;
    const {
        equipment_code,
        name,
        category,
        rfid_tag,
        status,
        calibration_limit,
        total_quantity
    } = req.body;

    const allowedStatuses = [
        "AVAILABLE",
        "IN_USE",
        "MAINTENANCE",
        "LOST"
    ];

    if (!equipment_code || !name || !category || !rfid_tag) {
        return res.status(400).json({
            message: "Please fill in all required fields."
        });
    }

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            message: "Invalid equipment status."
        });
    }

    const sql = `
        UPDATE equipment
        SET equipment_code = ?,
            name = ?,
            category = ?,
            rfid_tag = ?,
            status = ?,
            calibration_limit = ?,
            available_quantity = GREATEST(0, ? - (COALESCE(total_quantity, 1) - COALESCE(available_quantity, 1))),
            total_quantity = ?
        WHERE equipment_id = ?
    `;

    const values = [
        equipment_code,
        name,
        category,
        rfid_tag,
        status,
        calibration_limit || 500,
        Number.isSafeInteger(Number(total_quantity)) && Number(total_quantity) >= 1 ? Number(total_quantity) : 1,
        Number.isSafeInteger(Number(total_quantity)) && Number(total_quantity) >= 1 ? Number(total_quantity) : 1,
        id
    ];

    db.query(sql, values, (error, result) => {
        if (error) {
            console.error("Update equipment error:", error);
            return res.status(500).json({
                message: "Could not update equipment."
            });
        }

        if (result.affectedRows === 0) {
            return res.status(404).json({
                message: "Equipment not found."
            });
        }

        res.json({
            message: "Equipment updated successfully!"
        });
    });
});

// Public self-registration is disabled. Student accounts are created by administrators only.
app.post("/api/signup", loginLimiter, (req, res) => {
    return res.status(403).json({ message: "Student self-registration is disabled. Contact your lab administrator." });
});

// Administrator-created student accounts.
app.post("/api/admin/students", authenticateToken, requireAdmin, loginLimiter, (req, res) => {
    const { name, student_id, email, password, department = "", academic_year = "", section = "" } = req.body || {};
    if (!name || !student_id || !email || !password) return res.status(400).json({ message: "Name, student ID, email, and initial password are required." });
    const cleanName = String(name).trim();
    const cleanStudentId = String(student_id).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPassword = String(password);
    if (!cleanName || cleanName.length > 100 || !cleanStudentId || cleanStudentId.length > 50 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ message: "Enter a valid name, student ID, and email." });
    if (cleanPassword.length < 8 || cleanPassword.length > 128) return res.status(400).json({ message: "Initial password must be 8–128 characters." });
    db.query("SELECT user_id FROM users WHERE student_id = ? OR email = ?", [cleanStudentId, cleanEmail], (err, rows) => {
        if (err) { console.error("Student account check failed:", err.message); return res.status(500).json({ message: "Could not create the student account." }); }
        if (rows.length) return res.status(409).json({ message: "That student ID or email is already registered." });
        bcrypt.hash(cleanPassword, 12, (hashError, passwordHash) => {
            if (hashError) return res.status(500).json({ message: "Could not secure the password." });
            db.query("INSERT INTO users (name, student_id, email, password, department, academic_year, section, account_status, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'student', 1)", [cleanName, cleanStudentId, cleanEmail, passwordHash, String(department).trim() || null, String(academic_year).trim() || null, String(section).trim() || null], (insertError, result) => {
                if (insertError) {
                    if (insertError.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "That student ID or email is already registered." });
                    console.error("Student account insert failed:", insertError.message);
                    return res.status(500).json({ message: "Could not create the student account." });
                }
                return res.status(201).json({ message: "Student account created successfully.", student: { user_id: result.insertId, name: cleanName, student_id: cleanStudentId, email: cleanEmail, role: "student" } });
            });
        });
    });
});

// Admin-only student directory and RFID card linking.
// Uses the existing users.rfid_uid column; no additional table or migration is required.
app.get("/api/admin/students", authenticateToken, requireAdmin, (req, res) => {
    const sql = "SELECT * FROM users WHERE LOWER(role) = 'student' ORDER BY name ASC";

    db.query(sql, (err, rows) => {
        if (err) {
            console.error("Student directory query failed:", err.message);
            return res.status(500).json({ message: "Could not load students." });
        }
        return res.json({ students: rows.map(({ password, reset_token, reset_token_expires, ...row }) => ({ ...row, account_status: row.account_status || "ACTIVE", rfid_status: row.rfid_uid ? "ACTIVE" : null })) });
    });
});

app.post("/api/admin/students/:studentId/rfid-session", authenticateToken, requireAdmin, (req, res) => {
    const studentId = Number(req.params.studentId);
    if (!Number.isSafeInteger(studentId) || studentId < 1) return res.status(400).json({ message: "Invalid student account ID." });
    db.query("SELECT user_id,COALESCE(account_status,'ACTIVE') AS account_status FROM users WHERE user_id=? AND LOWER(role)='student' LIMIT 1", [studentId], (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not verify student account. Apply the reviewed registration migration first." });
        if (!rows.length) return res.status(404).json({ message: "Student account not found." });
        if (String(rows[0].account_status || "ACTIVE").toUpperCase() !== "ACTIVE") return res.status(409).json({ message: "Activate this student account before linking an RFID card." });
        db.query("UPDATE rfid_registration_sessions SET status='CANCELLED' WHERE status='PENDING' AND expires_at > NOW()", cancelError => {
            if (cancelError) return res.status(500).json({ message: "RFID registration session table is not ready. Apply the reviewed migration." });
            db.query("INSERT INTO rfid_registration_sessions (target_user_id,created_by,status,expires_at) VALUES (?,?, 'PENDING', DATE_ADD(NOW(), INTERVAL 3 MINUTE))", [studentId,req.user.user_id], (insertError, result) => {
                if (insertError) return res.status(500).json({ message: "Could not start RFID registration." });
                res.status(201).json({ message: "Registration mode is active. Tap the student's card on the ESP32 within 3 minutes.", registration_session_id: result.insertId, expires_in_seconds: 180 });
            });
        });
    });
});

app.put("/api/admin/students/:studentId/status", authenticateToken, requireAdmin, (req, res) => {
    const studentId = Number(req.params.studentId);
    const status = String((req.body || {}).account_status || "").toUpperCase();
    if (!Number.isSafeInteger(studentId) || studentId < 1 || !["ACTIVE","INACTIVE"].includes(status)) return res.status(400).json({ message: "Valid student ID and ACTIVE/INACTIVE status are required." });
    db.query("UPDATE users SET account_status=? WHERE user_id=? AND LOWER(role)='student'", [status,studentId], (err,result) => {
        if (err) return res.status(500).json({ message: "Could not update student status." });
        if (!result.affectedRows) return res.status(404).json({ message: "Student account not found." });
        res.json({ message: "Student account status updated.", account_status: status });
    });
});

app.put("/api/admin/students/:studentId/rfid", authenticateToken, requireAdmin, (req, res) => {
    const studentId = Number(req.params.studentId);
    const rawUid = String((req.body || {}).rfid_uid || "");
    const rfidUid = rawUid.replace(/[\s:-]/g, "").toUpperCase();

    if (!Number.isSafeInteger(studentId) || studentId < 1) {
        return res.status(400).json({ message: "Invalid student account ID." });
    }
    if (!/^[0-9A-F]{4,32}$/.test(rfidUid)) {
        return res.status(400).json({ message: "Enter a valid RFID UID (4–32 hexadecimal characters)." });
    }

    db.query(
        "SELECT user_id FROM users WHERE user_id = ? AND LOWER(role) = 'student' LIMIT 1",
        [studentId],
        (studentError, studentRows) => {
            if (studentError) {
                console.error("RFID student check failed:", studentError.message);
                return res.status(500).json({ message: "Could not verify the student account." });
            }
            if (!studentRows.length) {
                return res.status(404).json({ message: "Student account not found." });
            }

            db.query(
                "UPDATE users SET rfid_uid = ? WHERE user_id = ?",
                [rfidUid, studentId],
                (linkError) => {
                    if (linkError) {
                        if (linkError.code === "ER_DUP_ENTRY") {
                            return res.status(409).json({ message: "This RFID card is already linked to another student." });
                        }
                        console.error("RFID card link failed:", linkError.message);
                        return res.status(500).json({ message: "Could not link the RFID card." });
                    }

                    return res.json({
                        message: "RFID card linked successfully.",
                        student_id: studentId,
                        rfid_uid: rfidUid,
                        status: "ACTIVE"
                    });
                }
            );
        }
    );
});

app.post("/api/login", loginLimiter, (req, res) => {
    const { student_id, password } = req.body || {};
    if (!student_id || !password) return res.status(400).json({ message: "Student ID and password are required." });
    db.query("SELECT * FROM users WHERE student_id = ? LIMIT 1",
        [String(student_id).trim()], async (err, rows) => {
            if (err) {
                console.error("Login database error:", err.message);
                return res.status(500).json({ message: "Login is temporarily unavailable." });
            }
            if (!rows.length) return res.status(401).json({ message: "Invalid student ID or password." });
            const row = rows[0];
            const stored = String(row.password || "");
            let matches = false;
            try {
                matches = /^\$2[aby]\$/.test(stored) ? await bcrypt.compare(String(password), stored) : stored === String(password);
            } catch (verifyError) {
                console.error("Password verification error:", verifyError.message);
                return res.status(500).json({ message: "Login is temporarily unavailable." });
            }
            if (!matches) return res.status(401).json({ message: "Invalid student ID or password." });
            if (String(row.account_status || "ACTIVE").toUpperCase() !== "ACTIVE") return res.status(403).json({ message: "This account is inactive. Contact the lab administrator." });
            if (!/^\$2[aby]\$/.test(stored)) {
                try {
                    const upgraded = await bcrypt.hash(String(password), 12);
                    db.query("UPDATE users SET password = ? WHERE user_id = ?", [upgraded, row.user_id], upgradeError => {
                        if (upgradeError) console.error("Legacy password upgrade failed:", upgradeError.message);
                    });
                } catch (hashError) {
                    console.error("Password rehash failed:", hashError.message);
                }
            }
            const user = {
                user_id: row.user_id,
                name: row.name,
                student_id: row.student_id,
                email: row.email,
                role: String(row.role || "student").toLowerCase(),
                must_change_password: Boolean(row.must_change_password)
            };
            const token = jwt.sign(
                { user_id: user.user_id, student_id: user.student_id, role: user.role },
                JWT_SECRET,
                { expiresIn: "8h", issuer: "lems-api", audience: "lems-app" }
            );
            res.json({ message: "Login successful", user, token });
        });
});

// Mandatory initial password change for administrator-created student accounts.
app.post("/api/change-password", authenticateToken, loginLimiter, (req, res) => {
    const currentPassword = String((req.body || {}).current_password || "");
    const newPassword = String((req.body || {}).new_password || "");
    if (!currentPassword || newPassword.length < 8 || newPassword.length > 128) {
        return res.status(400).json({ message: "Enter your current password and a new password of 8–128 characters." });
    }
    db.query("SELECT user_id, password FROM users WHERE user_id = ? LIMIT 1", [req.user.user_id], async (err, rows) => {
        if (err || !rows.length) return res.status(500).json({ message: "Could not verify your account." });
        const stored = String(rows[0].password || "");
        let matches = false;
        try { matches = /^\$2[aby]\$/.test(stored) ? await bcrypt.compare(currentPassword, stored) : stored === currentPassword; }
        catch { return res.status(500).json({ message: "Could not verify your password." }); }
        if (!matches) return res.status(401).json({ message: "Current password is incorrect." });
        if (currentPassword === newPassword) return res.status(400).json({ message: "Choose a password different from your initial password." });
        try {
            const hash = await bcrypt.hash(newPassword, 12);
            db.query("UPDATE users SET password = ?, must_change_password = 0 WHERE user_id = ?", [hash, req.user.user_id], updateError => {
                if (updateError) return res.status(500).json({ message: "Could not update your password." });
                return res.json({ message: "Password changed successfully. Please sign in again." });
            });
        } catch { return res.status(500).json({ message: "Could not secure your new password." }); }
    });
});

// Forgot Password API - Generates reset link & sends real email
app.post("/api/forgot-password", loginLimiter, (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required." });

    // Production reset emails must be configured before a token is created.
    if (process.env.NODE_ENV === "production" && !transporter) {
        return res.status(503).json({ message: "Password-reset email is not configured. Please contact the lab administrator." });
    }

    const checkSql = "SELECT user_id, name, email FROM users WHERE LOWER(email) = ? LIMIT 1";
    db.query(checkSql, [email], (err, users) => {
        if (err) {
            console.error("Forgot-password lookup failed:", err.message);
            return res.status(500).json({ message: "Password reset is temporarily unavailable." });
        }
        if (!users.length) {
            if (process.env.NODE_ENV === "production") {
                return res.json({ message: "If the account exists, password-reset instructions will be sent to its registered email." });
            }
            return res.status(404).json({ message: "No account found with this email address." });
        }

        const user = users[0];
        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 60 * 60 * 1000);
        db.query("UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE user_id = ?", [token, expires, user.user_id], (updateError) => {
            if (updateError) {
                console.error("Could not save password-reset token:", updateError.message);
                return res.status(500).json({ message: "Password reset is temporarily unavailable." });
            }

            const baseUrl = (process.env.APP_BASE_URL || (req.protocol + "://" + req.get("host"))).replace(/\/+$/, "");
            const resetLink = baseUrl + "/reset-password?token=" + encodeURIComponent(token);
            const mailOptions = {
                from: '"LEMS System" <' + EMAIL_USER + ">",
                to: user.email,
                subject: "LEMS - Password Reset Request",
                text: "A password reset was requested for your LEMS account. This link expires in one hour: " + resetLink + "\nIf you did not request this, ignore this email.",
                html: '<div style="font-family:Arial,sans-serif;padding:20px"><h2>LEMS password reset</h2><p>Hello ' +
                    String(user.name || "User").replace(/[&<>"]/g, "") +
                    ',</p><p>Use this one-hour link to reset your LEMS password:</p><p><a href="' + resetLink + '">Reset password</a></p><p>If you did not request this, ignore this email.</p></div>'
            };
            transporter.sendMail(mailOptions, (mailError) => {
                if (mailError) {
                    console.error("Password-reset email delivery failed:", mailError.message);
                    return res.status(503).json({ message: "Password-reset email could not be sent. Please contact the lab administrator." });
                }
                // Prevent account enumeration in production.
                if (process.env.NODE_ENV === "production") {
                    return res.json({ message: "If the account exists, password-reset instructions will be sent to its registered email." });
                }
                res.json({ message: "Password reset email sent.", resetLink });
            });
        });
    });
});

// Reset Password API - Updates password using token
app.post("/api/reset-password", loginLimiter, (req, res) => {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
        return res.status(400).json({ message: "Token and new password are required." });
    }

    const checkSql = "SELECT user_id, reset_token_expires FROM users WHERE reset_token = ?";
    db.query(checkSql, [token.trim()], (err, users) => {
        if (err) {
            console.error("Reset password check error:", err);
            return res.status(500).json({ error: err.message });
        }

        if (users.length === 0) {
            return res.status(400).json({ message: "Invalid or unrecognized password reset token." });
        }

        const user = users[0];

        // Expired, missing, and invalid expiry timestamps must all be rejected.
        const expiryMs = user.reset_token_expires ? new Date(user.reset_token_expires).getTime() : Number.NaN;
        if (!Number.isFinite(expiryMs) || expiryMs < Date.now()) {
            return res.status(400).json({ message: "Invalid or expired password-reset link." });
        }

        if (String(new_password).length < 8 || String(new_password).length > 128) {
            return res.status(400).json({ message: "Password must be between 8 and 128 characters." });
        }
        const userId = user.user_id;
        bcrypt.hash(String(new_password), 12, (hashError, passwordHash) => {
            if (hashError) return res.status(500).json({ message: "Could not secure the new password." });
            const updateSql = "UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE user_id = ?";
            db.query(updateSql, [passwordHash, userId], (updateError) => {
                if (updateError) {
                    console.error("Password update failed:", updateError.message);
                    return res.status(500).json({ message: "Password reset failed." });
                }
                res.json({ message: "Password reset successful. You can now sign in." });
            });
        });
    });
});

// Submit Complaint / Maintenance Request API (Student Side)
app.post("/api/complaints", authenticateToken, (req, res) => {
    const { equipment_id, issue_description } = req.body || {};
    const user_id = req.user.user_id;

    if (!user_id || !equipment_id || !issue_description) {
        return res.status(400).json({ message: "User ID, Equipment ID, and Issue Description are required." });
    }

    const insertSql = `
        INSERT INTO complaints (user_id, equipment_id, issue_description, status)
        VALUES (?, ?, ?, 'PENDING')
    `;

    db.query(insertSql, [user_id, equipment_id, issue_description.trim()], (err, result) => {
        if (err) {
            console.error("Submit complaint error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        // Update equipment status to MAINTENANCE
        db.query("UPDATE equipment SET status = 'MAINTENANCE' WHERE equipment_id = ?", [equipment_id], (err) => {
            if (err) console.error("Error updating equipment status to MAINTENANCE:", err.message);
        });

        res.status(201).json({
            message: "Maintenance complaint submitted successfully! Equipment marked for review."
        });
    });
});

// Students can only see their own complaints and statuses.
app.get("/api/my-complaints", authenticateToken, (req, res) => {
    const sql = "SELECT c.complaint_id,c.issue_description,c.status,c.created_at,e.equipment_code,e.name AS equipment_name FROM complaints c LEFT JOIN equipment e ON e.equipment_id=c.equipment_id WHERE c.user_id=? ORDER BY c.complaint_id DESC";
    db.query(sql, [req.user.user_id], (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not load your complaint history." });
        res.json(rows);
    });
});

// Get All Complaints API (Admin Side)
app.get("/api/complaints", authenticateToken, requireAdmin, (req, res) => {
    const sql = `
        SELECT
            c.complaint_id,
            c.issue_description,
            c.status AS complaint_status,
            c.created_at,
            u.name AS student_name,
            u.student_id,
            e.equipment_id,
            e.equipment_code,
            e.name AS equipment_name,
            e.status AS equipment_status
        FROM complaints c
        LEFT JOIN users u ON c.user_id = u.user_id
        LEFT JOIN equipment e ON c.equipment_id = e.equipment_id
        ORDER BY c.complaint_id DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("Get complaints warning:", err.message);
            // Return empty list safely if table doesn't exist yet
            return res.json([]);
        }

        res.json(results);
    });
});

// Resolve Complaint API (Admin Side)
app.put("/api/complaints/:id/resolve", authenticateToken, requireAdmin, (req, res) => {
    const complaintId = req.params.id;
    const { equipment_id, make_available } = req.body;

    const updateSql = "UPDATE complaints SET status = 'RESOLVED' WHERE complaint_id = ?";
    db.query(updateSql, [complaintId], (err, result) => {
        if (err) {
            console.error("Resolve complaint error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        if (make_available !== false && equipment_id) {
            db.query("UPDATE equipment SET status = 'AVAILABLE' WHERE equipment_id = ?", [equipment_id], (err) => {
                if (err) console.error("Error restoring equipment status to AVAILABLE:", err.message);
            });
        }

        res.json({ message: "Complaint resolved and equipment status updated!" });
    });
});

// Multi-item checkout QR workflow. Run backend/migrations/20261015_checkout_qr.sql first.
const hashQrToken = value => crypto.createHash("sha256").update(String(value)).digest("hex");

app.post("/api/checkout-requests", authenticateToken, (req, res) => {
    // Preferred payload: items: [{ equipment_id, quantity }]. Legacy equipment_ids remains supported.
    const rawItems = Array.isArray(req.body && req.body.items)
        ? req.body.items
        : Array.isArray(req.body && req.body.equipment_ids)
            ? req.body.equipment_ids.map(equipment_id => ({ equipment_id, quantity: 1 }))
            : null;
    if (!rawItems || rawItems.length < 1 || rawItems.length > 25) {
        return res.status(400).json({ message: "Select 1–25 equipment types for checkout." });
    }
    const items = rawItems.map(item => ({
        equipment_id: Number(item && item.equipment_id),
        quantity: Number(item && item.quantity)
    }));
    const ids = items.map(item => item.equipment_id);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) ||
        items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 500) ||
        new Set(ids).size !== ids.length) {
        return res.status(400).json({ message: "Each equipment type must appear once with a whole-number quantity between 1 and 500." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashQrToken(token);
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Checkout request is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start checkout request." }); }
            connection.query("SELECT equipment_id, name, equipment_code, status, COALESCE(available_quantity, 1) AS available_quantity FROM equipment WHERE equipment_id IN (?) FOR UPDATE", [ids], (selectError, rows) => {
                if (selectError || rows.length !== ids.length) {
                    return connection.rollback(() => { connection.release(); res.status(selectError ? 500 : 400).json({ message: selectError ? "Could not validate equipment." : "One or more selected items no longer exist." }); });
                }
                const byId = new Map(rows.map(row => [Number(row.equipment_id), row]));
                const unavailable = items.filter(item => {
                    const equipment = byId.get(item.equipment_id);
                    return !equipment || String(equipment.status || "").toUpperCase() !== "AVAILABLE" || Number(equipment.available_quantity) < item.quantity;
                }).map(item => {
                    const equipment = byId.get(item.equipment_id);
                    return { equipment_code: equipment?.equipment_code || String(item.equipment_id), requested: item.quantity, available: Number(equipment?.available_quantity || 0) };
                });
                if (unavailable.length) {
                    return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Requested quantity exceeds available stock or equipment is unavailable.", unavailable }); });
                }
                connection.query("INSERT INTO checkout_requests (user_id, token_hash, status) VALUES (?, ?, 'PENDING')", [req.user.user_id, tokenHash], (insertError, result) => {
                    if (insertError) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not create checkout request. Apply the reviewed quantity/return migration first." }); });
                    const values = items.map(item => [result.insertId, item.equipment_id, item.quantity]);
                    connection.query("INSERT INTO checkout_request_items (request_id, equipment_id, quantity) VALUES ?", [values], itemError => {
                        if (itemError) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not save the selected quantities. Check that the quantity migration is applied." }); });
                        connection.commit(commitError => {
                            connection.release();
                            if (commitError) return res.status(500).json({ message: "Could not save checkout request." });
                            res.status(201).json({ message: "Checkout QR request created. Show this QR to the lab administrator.", request_id: result.insertId, token, status: "PENDING", items: items.map(item => { const equipment = byId.get(item.equipment_id); return { equipment_id: item.equipment_id, equipment_code: equipment.equipment_code, name: equipment.name, quantity: item.quantity }; }) });
                        });
                    });
                });
            });
        });
    });
});

app.post("/api/admin/checkout-requests/scan", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid checkout QR token is required." });
    db.query("SELECT r.request_id, r.status, r.created_at, u.user_id, u.name AS student_name, u.student_id FROM checkout_requests r JOIN users u ON u.user_id = r.user_id WHERE r.token_hash = ? LIMIT 1", [hashQrToken(token)], (err, requests) => {
        if (err) return res.status(500).json({ message: "Could not verify QR request. Ensure the QR migration is applied." });
        if (!requests.length) return res.status(404).json({ message: "QR token not found." });
        const request = requests[0];
        if (request.status !== "PENDING") return res.status(409).json({ message: "This QR request has already been used or cancelled.", status: request.status });
        db.query("SELECT e.equipment_id, e.equipment_code, e.name, e.status, COALESCE(e.available_quantity, 1) AS available_quantity, COALESCE(i.quantity, 1) AS quantity FROM checkout_request_items i JOIN equipment e ON e.equipment_id = i.equipment_id WHERE i.request_id = ? ORDER BY i.request_item_id", [request.request_id], (itemError, items) => {
            if (itemError) return res.status(500).json({ message: "Could not load requested equipment." });
            res.json({ request: { request_id: request.request_id, status: request.status, created_at: request.created_at }, student: { user_id: request.user_id, name: request.student_name, student_id: request.student_id }, items });
        });
    });
});

app.post("/api/admin/checkout-requests/issue", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid checkout QR token is required." });
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Issue operation is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start issue operation." }); }
            connection.query("SELECT request_id, user_id, status FROM checkout_requests WHERE token_hash = ? FOR UPDATE", [hashQrToken(token)], (requestError, requests) => {
                if (requestError || !requests.length) return connection.rollback(() => { connection.release(); res.status(requestError ? 500 : 404).json({ message: requestError ? "Could not verify checkout request." : "QR token not found." }); });
                const request = requests[0];
                if (request.status !== "PENDING") return connection.rollback(() => { connection.release(); res.status(409).json({ message: "This QR has already been used or cancelled.", status: request.status }); });
                connection.query("SELECT e.equipment_id, e.equipment_code, e.status, COALESCE(e.available_quantity, 1) AS available_quantity, COALESCE(i.quantity, 1) AS quantity FROM checkout_request_items i JOIN equipment e ON e.equipment_id = i.equipment_id WHERE i.request_id = ? FOR UPDATE", [request.request_id], (itemsError, items) => {
                    if (itemsError || !items.length) return connection.rollback(() => { connection.release(); res.status(itemsError ? 500 : 400).json({ message: "No equipment found in this checkout request." }); });
                    if (items.some(item => String(item.status).toUpperCase() !== "AVAILABLE" || Number(item.available_quantity) < Number(item.quantity || 1))) {
                        return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Requested stock is no longer available. No equipment was issued; create a new request after refreshing inventory." }); });
                    }
                    const transactionRows = [];
                    for (const item of items) {
                        for (let count = 0; count < Number(item.quantity || 1); count++) transactionRows.push([request.user_id, item.equipment_id, "ACTIVE"]);
                    }
                    connection.query("INSERT INTO transactions (user_id, equipment_id, status, checkout_request_id) VALUES ?", [transactionRows.map(row => [row[0],row[1],row[2],request.request_id])], insertError => {
                        if (insertError) { console.error("[checkout issue] transaction insert failed:", insertError.code || "UNKNOWN", insertError.message || "No database error message"); return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not record the equipment issue." }); }); }
                        let remaining = items.length;
                        let updateFailed = false;
                        items.forEach(item => {
                            connection.query("UPDATE equipment SET available_quantity = GREATEST(0, COALESCE(available_quantity, 1) - ?), status = CASE WHEN COALESCE(available_quantity, 1) - ? <= 0 THEN 'IN_USE' ELSE 'AVAILABLE' END WHERE equipment_id = ? AND COALESCE(available_quantity, 1) >= ?", [item.quantity, item.quantity, item.equipment_id, item.quantity], (updateError, updateResult) => {
                                if (updateError || updateResult.affectedRows !== 1) updateFailed = true;
                                remaining--;
                                if (remaining !== 0) return;
                                if (updateFailed) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Stock changed while issuing. No issue was saved; refresh and retry." }); });
                                connection.query("UPDATE checkout_requests SET status = 'ISSUED', issued_at = NOW(), issued_by = ? WHERE request_id = ? AND status = 'PENDING'", [req.user.user_id, request.request_id], (markError, result) => {
                                    if (markError || result.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Checkout request state changed. No issue was saved." }); });
                                    connection.commit(commitError => {
                                        connection.release();
                                        if (commitError) return res.status(500).json({ message: "Issue could not be committed. Check transaction history before retrying." });
                                        res.json({ message: "Equipment issued successfully.", request_id: request.request_id, equipment: items.map(item => ({ equipment_id: item.equipment_id, equipment_code: item.equipment_code, quantity: Number(item.quantity || 1) })), total_units: transactionRows.length });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Checkout equipment API
app.post("/api/checkout", authenticateToken, (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "admin") {
        return res.status(403).json({ message: "Student checkout must use the QR checkout request and admin issue workflow." });
    }

    const { equipment_id } = req.body || {};
    const user_id = req.user.user_id;

    if (!user_id || !equipment_id) {
        return res.status(400).json({
            message: "User ID and equipment ID are required"
        });
    }

    // Check student exists
    db.query(
        "SELECT user_id FROM users WHERE user_id = ?",
        [user_id],
        (err, users) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            if (users.length === 0) {
                return res.status(404).json({
                    message: "Student not found. Please log in again."
                });
            }

            // Check if user already has an active checkout for this equipment
            db.query(
                "SELECT transaction_id FROM transactions WHERE user_id = ? AND equipment_id = ? AND status = 'ACTIVE'",
                [user_id, equipment_id],
                (err, activeTxs) => {
                    if (err) {
                        return res.status(500).json({ error: err.message });
                    }

                    if (activeTxs.length > 0) {
                        return res.status(400).json({
                            message: "You already have an active checkout for this equipment. You must return it first."
                        });
                    }

                    // Check equipment availability and quantity
                    db.query(
                        "SELECT status, COALESCE(available_quantity, 50) AS available_quantity, COALESCE(total_quantity, 50) AS total_quantity FROM equipment WHERE equipment_id = ?",
                        [equipment_id],
                        (err, equipment) => {
                            if (err) {
                                return res.status(500).json({ error: err.message });
                            }

                            if (equipment.length === 0) {
                                return res.status(404).json({
                                    message: "Equipment not found"
                                });
                            }

                            const eq = equipment[0];
                            if (eq.status === "MAINTENANCE" || eq.status === "LOST" || eq.available_quantity <= 0) {
                                return res.status(400).json({
                                    message: "Equipment is out of stock or under maintenance."
                                });
                            }

                            // Record checkout
                            db.query(
                                `INSERT INTO transactions
                                 (user_id, equipment_id, status)
                                 VALUES (?, ?, 'ACTIVE')`,
                                [user_id, equipment_id],
                                (err, result) => {
                                    if (err) {
                                        return res.status(500).json({ error: err.message });
                                    }

                                    // Decrement available_quantity and set status to OUT_OF_STOCK if 0
                                    db.query(
                                        `UPDATE equipment
                                         SET available_quantity = GREATEST(0, COALESCE(available_quantity, 50) - 1),
                                             status = CASE WHEN (COALESCE(available_quantity, 50) - 1) <= 0 THEN 'IN_USE' ELSE 'AVAILABLE' END
                                         WHERE equipment_id = ?`,
                                        [equipment_id],
                                        (err, updateResult) => {
                                            if (err) {
                                                db.query(
                                                    `DELETE FROM transactions WHERE transaction_id = ?`,
                                                    [result.insertId]
                                                );
                                                return res.status(500).json({ error: err.message });
                                            }

                                            res.json({
                                                message: "Equipment checked out successfully",
                                                transaction_id: result.insertId
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

// Student creates a one-time return QR for an active transaction.
// Batch return requests support selecting any subset of active unit-level transactions.
app.post("/api/return-requests", authenticateToken, (req, res) => {
    const raw = req.body && req.body.transaction_ids;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 25) return res.status(400).json({ message: "Select 1–25 borrowed units to return." });
    const ids = raw.map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) return res.status(400).json({ message: "Return selection contains invalid or duplicate transaction IDs." });
    const token = crypto.randomBytes(32).toString("hex");
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Return request is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start return request." }); }
            connection.query("SELECT t.transaction_id,t.user_id,t.equipment_id,t.status,e.equipment_code,e.name AS equipment_name FROM transactions t JOIN equipment e ON e.equipment_id=t.equipment_id WHERE t.transaction_id IN (?) FOR UPDATE", [ids], (selectError, rows) => {
                if (selectError || rows.length !== ids.length) return connection.rollback(() => { connection.release(); res.status(selectError ? 500 : 404).json({ message: "One or more selected loans could not be found." }); });
                if (rows.some(row => Number(row.user_id) !== Number(req.user.user_id) && String(req.user.role).toLowerCase() !== "admin")) return connection.rollback(() => { connection.release(); res.status(403).json({ message: "You can only return your own borrowed equipment." }); });
                if (rows.some(row => row.status !== "ACTIVE")) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "One or more selected units are no longer outstanding." }); });
                connection.query("INSERT INTO return_sessions (user_id,token_hash,status) VALUES (?,?,'PENDING')", [req.user.user_id, hashQrToken(token)], (insertError, result) => {
                    if (insertError) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not create return session. Apply the reviewed quantity/return migration first." }); });
                    connection.query("INSERT INTO return_session_items (return_session_id,transaction_id) VALUES ?", [ids.map(id => [result.insertId,id])], itemError => {
                        if (itemError) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not save return selection." }); });
                        connection.commit(commitError => { connection.release(); if (commitError) return res.status(500).json({ message: "Could not save return request." }); res.status(201).json({ message: "Return QR created for the selected units.", return_session_id: result.insertId, token, items: rows.map(row => ({ transaction_id: row.transaction_id, equipment_code: row.equipment_code, equipment_name: row.equipment_name })) }); });
                    });
                });
            });
        });
    });
});

app.post("/api/admin/return-requests/scan", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid return QR token is required." });
    db.query("SELECT s.return_session_id,s.user_id,s.status,s.created_at,u.name AS student_name,u.student_id FROM return_sessions s JOIN users u ON u.user_id=s.user_id WHERE s.token_hash=? LIMIT 1", [hashQrToken(token)], (err, sessions) => {
        if (err) return res.status(500).json({ message: "Could not verify return QR. Apply the reviewed quantity/return migration first." });
        if (!sessions.length) return res.status(404).json({ message: "Return QR not found." });
        const session = sessions[0];
        if (session.status !== "PENDING") return res.status(409).json({ message: "This return QR has already been processed.", status: session.status });
        db.query("SELECT i.transaction_id,i.condition_status,t.equipment_id,e.equipment_code,e.name AS equipment_name,t.status AS transaction_status FROM return_session_items i JOIN transactions t ON t.transaction_id=i.transaction_id JOIN equipment e ON e.equipment_id=t.equipment_id WHERE i.return_session_id=? ORDER BY i.return_session_item_id", [session.return_session_id], (itemError, items) => {
            if (itemError) return res.status(500).json({ message: "Could not load return items." });
            if (items.some(item => item.transaction_status !== "ACTIVE")) return res.status(409).json({ message: "A selected unit is no longer outstanding. Create a new return request." });
            res.json({ session: { return_session_id: session.return_session_id, status: session.status, created_at: session.created_at }, student: { user_id: session.user_id, name: session.student_name, student_id: session.student_id }, items });
        });
    });
});

app.post("/api/admin/return-requests/confirm", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid return QR token is required." });
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Return confirmation is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start return confirmation." }); }
            connection.query("SELECT return_session_id,user_id,status FROM return_sessions WHERE token_hash=? FOR UPDATE", [hashQrToken(token)], (sessionError, sessions) => {
                if (sessionError || !sessions.length) return connection.rollback(() => { connection.release(); res.status(sessionError ? 500 : 404).json({ message: "Return QR not found." }); });
                const session = sessions[0];
                if (session.status !== "PENDING") return connection.rollback(() => { connection.release(); res.status(409).json({ message: "This return QR has already been processed." }); });
                connection.query("SELECT i.return_session_item_id,i.transaction_id,COALESCE(i.condition_status,'GOOD') AS condition_status,i.condition_notes,t.equipment_id,t.status AS transaction_status FROM return_session_items i JOIN transactions t ON t.transaction_id=i.transaction_id WHERE i.return_session_id=? FOR UPDATE", [session.return_session_id], (itemsError, items) => {
                    if (itemsError || !items.length) return connection.rollback(() => { connection.release(); res.status(itemsError ? 500 : 400).json({ message: "No return items were found." }); });
                    if (items.some(item => item.transaction_status !== "ACTIVE")) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "A selected unit is no longer outstanding." }); });
                    let index = 0, failed = false;
                    const next = () => {
                        if (index >= items.length) {
                            if (failed) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Return was not saved. No inventory changes were committed." }); });
                            connection.query("UPDATE return_sessions SET status='CONFIRMED',confirmed_at=NOW(),confirmed_by=? WHERE return_session_id=? AND status='PENDING'", [req.user.user_id,session.return_session_id], (markError, result) => {
                                if (markError || result.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Return session state changed." }); });
                                connection.commit(commitError => { connection.release(); if (commitError) return res.status(500).json({ message: "Return commit failed. Check transaction history before retrying." }); res.json({ message: "Selected equipment returned successfully.", returned_units: items.length }); });
                            });
                            return;
                        }
                        const item = items[index++];
                        connection.query("UPDATE transactions SET status='RETURNED',return_time=NOW() WHERE transaction_id=? AND status='ACTIVE'", [item.transaction_id], (txError, txResult) => {
                            if (txError || txResult.affectedRows !== 1) { failed = true; return next(); }
                            const damaged = item.condition_status === "DAMAGED" || item.condition_status === "MISSING_PARTS";
                            const stockSql = damaged
                                ? "UPDATE equipment SET status='MAINTENANCE' WHERE equipment_id=?"
                                : "UPDATE equipment SET available_quantity=LEAST(COALESCE(total_quantity,1),COALESCE(available_quantity,0)+1),status=CASE WHEN COALESCE(available_quantity,0)+1>0 THEN 'AVAILABLE' ELSE status END WHERE equipment_id=?";
                            connection.query(stockSql, [item.equipment_id], stockError => {
                                if (stockError) { failed = true; return next(); }
                                connection.query("INSERT INTO equipment_condition_reports (transaction_id,equipment_id,user_id,return_session_id,condition_status,notes) VALUES (?,?,?,?,?,?)", [item.transaction_id,item.equipment_id,session.user_id,session.return_session_id,item.condition_status,item.condition_notes||null], reportError => {
                                    if (reportError) { failed = true; return next(); }
                                    connection.query("UPDATE return_session_items SET processed_at=NOW() WHERE return_session_item_id=?", [item.return_session_item_id], () => next());
                                });
                            });
                        });
                    };
                    next();
                });
            });
        });
    });
});

app.post("/api/return-qr", authenticateToken, (req, res) => {
    const transactionId = Number((req.body || {}).transaction_id);
    if (!Number.isInteger(transactionId) || transactionId < 1) return res.status(400).json({ message: "A valid transaction ID is required." });
    const token = crypto.randomBytes(32).toString("hex");
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Return QR is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start return request." }); }
            connection.query("SELECT transaction_id, user_id, equipment_id, status FROM transactions WHERE transaction_id = ? FOR UPDATE", [transactionId], (err, rows) => {
                if (err || !rows.length) return connection.rollback(() => { connection.release(); res.status(err ? 500 : 404).json({ message: err ? "Could not load transaction." : "Transaction not found." }); });
                const tx = rows[0];
                if (String(req.user.role).toLowerCase() !== "admin" && Number(tx.user_id) !== Number(req.user.user_id)) return connection.rollback(() => { connection.release(); res.status(403).json({ message: "You can only create a return QR for your own loan." }); });
                if (tx.status !== "ACTIVE") return connection.rollback(() => { connection.release(); res.status(409).json({ message: "This transaction is not active." }); });
                connection.query("SELECT return_token_id FROM return_qr_tokens WHERE transaction_id = ? AND status = 'PENDING' LIMIT 1", [transactionId], (checkErr, existing) => {
                    if (checkErr) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not check existing return requests." }); });
                    if (existing.length) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "A pending return QR already exists for this transaction." }); });
                    connection.query("INSERT INTO return_qr_tokens (transaction_id, token_hash, status) VALUES (?, ?, 'PENDING')", [transactionId, hashQrToken(token)], insertErr => {
                        if (insertErr) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not create return QR. Ensure the QR migration is applied." }); });
                        connection.commit(commitErr => { connection.release(); if (commitErr) return res.status(500).json({ message: "Could not save return QR." }); res.status(201).json({ message: "Return QR created. Show it to the lab administrator.", token, transaction_id: transactionId }); });
                    });
                });
            });
        });
    });
});

// Admin scans/validates a return QR; no inventory changes until confirm.
app.post("/api/admin/return-qr/scan", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid return QR token is required." });
    db.query("SELECT rt.return_token_id, rt.status AS token_status, t.transaction_id, t.user_id, t.equipment_id, t.status AS transaction_status, u.name AS student_name, u.student_id, e.equipment_code, e.name AS equipment_name FROM return_qr_tokens rt JOIN transactions t ON t.transaction_id = rt.transaction_id JOIN users u ON u.user_id = t.user_id JOIN equipment e ON e.equipment_id = t.equipment_id WHERE rt.token_hash = ? LIMIT 1", [hashQrToken(token)], (err, rows) => {
        if (err) return res.status(500).json({ message: "Could not verify return QR. Ensure the QR migration is applied." });
        if (!rows.length) return res.status(404).json({ message: "Return QR token not found." });
        const row = rows[0];
        if (row.token_status !== "PENDING" || row.transaction_status !== "ACTIVE") return res.status(409).json({ message: "This return QR has already been used or the loan is no longer active." });
        res.json({ student: { name: row.student_name, student_id: row.student_id }, item: { transaction_id: row.transaction_id, equipment_id: row.equipment_id, equipment_code: row.equipment_code, name: row.equipment_name }, status: "PENDING" });
    });
});

// Admin confirms a scanned return QR. Token use, transaction status and stock update are atomic.
app.post("/api/admin/return-qr/confirm", authenticateToken, requireAdmin, (req, res) => {
    const token = String((req.body || {}).token || "").trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ message: "A valid return QR token is required." });
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Return confirmation is temporarily unavailable." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start return confirmation." }); }
            connection.query("SELECT return_token_id, transaction_id, status FROM return_qr_tokens WHERE token_hash = ? FOR UPDATE", [hashQrToken(token)], (tokenError, tokens) => {
                if (tokenError || !tokens.length) return connection.rollback(() => { connection.release(); res.status(tokenError ? 500 : 404).json({ message: tokenError ? "Could not validate token." : "Return QR token not found." }); });
                const qr = tokens[0];
                if (qr.status !== "PENDING") return connection.rollback(() => { connection.release(); res.status(409).json({ message: "This return QR has already been used." }); });
                connection.query("SELECT transaction_id, equipment_id, status FROM transactions WHERE transaction_id = ? FOR UPDATE", [qr.transaction_id], (txError, txs) => {
                    if (txError || !txs.length || txs[0].status !== "ACTIVE") return connection.rollback(() => { connection.release(); res.status(txError ? 500 : 409).json({ message: "The loan is no longer active." }); });
                    const tx = txs[0];
                    connection.query("UPDATE transactions SET status = 'RETURNED', return_time = NOW() WHERE transaction_id = ? AND status = 'ACTIVE'", [tx.transaction_id], (updateTxError, result) => {
                        if (updateTxError || result.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Return was not recorded." }); });
                        connection.query("UPDATE equipment SET available_quantity = LEAST(COALESCE(total_quantity, 50), COALESCE(available_quantity, 0) + 1), status = 'AVAILABLE' WHERE equipment_id = ?", [tx.equipment_id], stockError => {
                            if (stockError) return connection.rollback(() => { connection.release(); res.status(500).json({ message: "Could not update available stock." }); });
                            connection.query("UPDATE return_qr_tokens SET status = 'USED', used_at = NOW(), used_by = ? WHERE return_token_id = ? AND status = 'PENDING'", [req.user.user_id, qr.return_token_id], (markError, markResult) => {
                                if (markError || markResult.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(409).json({ message: "Return QR was already consumed." }); });
                                connection.commit(commitError => { connection.release(); if (commitError) return res.status(500).json({ message: "Could not commit return. Check transaction history before retrying." }); res.json({ message: "Equipment return confirmed successfully.", transaction_id: tx.transaction_id }); });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Return equipment API
app.post("/api/return", authenticateToken, (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "admin") {
        return res.status(403).json({ message: "Student returns must use the return QR and admin confirmation workflow." });
    }

    const { equipment_id } = req.body || {};
    const currentUserId = req.user.user_id;
    const isAdministrator = String(req.user.role || "").toLowerCase() === "admin";

    if (!equipment_id) {
        return res.status(400).json({
            message: "Equipment ID is required"
        });
    }

    const sql = `
        SELECT transaction_id
        FROM transactions
        WHERE equipment_id = ?
          AND status = 'ACTIVE'
          AND (? = 1 OR user_id = ?)
        ORDER BY checkout_time DESC
        LIMIT 1
    `;

    db.query(sql, [equipment_id, isAdministrator ? 1 : 0, currentUserId], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        if (results.length === 0) {
            return res.status(400).json({
                message: "No active checkout found"
            });
        }

        const transactionId = results[0].transaction_id;

        db.query(
            `UPDATE transactions
             SET status = 'RETURNED', return_time = NOW()
             WHERE transaction_id = ? AND status = 'ACTIVE'`,
            [transactionId],
            (err, result) => {
                if (err) {
                    return res.status(500).json({ error: err.message });
                }

                if (result.affectedRows === 0) {
                    return res.status(409).json({
                        message: "This transaction has already been returned"
                    });
                }

                // Increment available_quantity and set status to AVAILABLE
                db.query(
                    `UPDATE equipment
                     SET available_quantity = LEAST(COALESCE(total_quantity, 50), COALESCE(available_quantity, 0) + 1),
                         status = 'AVAILABLE'
                     WHERE equipment_id = ?`,
                    [equipment_id],
                    (err, updateResult) => {
                        if (err) {
                            return res.status(500).json({ error: err.message });
                        }

                        res.json({
                            message: "Equipment returned successfully"
                        });
                    }
                );
            }
        );
    });
});

// RFID Kiosk Scan API (ESP32 Hardware Integration)
// Kiosk RFID verification: card UID is an identifier only; active account status is checked in MySQL.
app.post("/api/kiosk/verify-rfid", verifyKioskKey, (req, res) => {
    const uid = String((req.body || {}).uid || "").replace(/[\\s:-]/g, "").toUpperCase();
    if (!/^[0-9A-F]{4,32}$/.test(uid)) return res.status(400).json({ valid: false, message: "Invalid RFID UID format." });
    // An admin-created registration session is time-limited and single-use.
    db.query("SELECT registration_session_id,target_user_id FROM rfid_registration_sessions WHERE status='PENDING' AND expires_at>NOW() ORDER BY registration_session_id DESC LIMIT 1", [], (sessionError, sessions) => {
        if (sessionError) {
            // Keep normal RFID verification working on an existing database until the additive migration is applied.
            return db.query("SELECT * FROM users WHERE rfid_uid=? LIMIT 1", [uid], (verifyError, rows) => {
                if (verifyError) return res.status(500).json({ valid: false, message: "Student verification is unavailable." });
                if (!rows.length || String(rows[0].role || "").toLowerCase() !== "student" || String(rows[0].account_status || "ACTIVE").toUpperCase() !== "ACTIVE") return res.status(200).json({ valid: false, message: "Invalid or inactive Student Card. Access denied." });
                res.json({ valid: true, registration: false, message: "Student verified.", student: { user_id: rows[0].user_id, name: rows[0].name, student_id: rows[0].student_id } });
            });
        }
        if (sessions.length) {
            const session = sessions[0];
            db.getConnection((connectionError, connection) => {
                if (connectionError) return res.status(500).json({ valid: false, message: "RFID registration is temporarily unavailable." });
                connection.beginTransaction(beginError => {
                    if (beginError) { connection.release(); return res.status(500).json({ valid: false, message: "Could not start RFID registration." }); }
                    connection.query("SELECT registration_session_id,target_user_id FROM rfid_registration_sessions WHERE registration_session_id=? AND status='PENDING' AND expires_at>NOW() FOR UPDATE", [session.registration_session_id], (lockError, active) => {
                        if (lockError || !active.length) return connection.rollback(() => { connection.release(); res.status(409).json({ valid: false, message: "RFID registration session expired. Start again." }); });
                        connection.query("UPDATE users SET rfid_uid=? WHERE user_id=? AND LOWER(role)='student' AND COALESCE(account_status,'ACTIVE')='ACTIVE'", [uid,active[0].target_user_id], (linkError, linked) => {
                            if (linkError || linked.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(linkError?.code === "ER_DUP_ENTRY" ? 409 : 500).json({ valid: false, message: linkError?.code === "ER_DUP_ENTRY" ? "Card Already Registered" : "Could not link RFID card." }); });
                            connection.query("UPDATE rfid_registration_sessions SET status='USED',used_at=NOW(),used_uid=? WHERE registration_session_id=? AND status='PENDING'", [uid,active[0].registration_session_id], (markError, marked) => {
                                if (markError || marked.affectedRows !== 1) return connection.rollback(() => { connection.release(); res.status(409).json({ valid: false, message: "Registration session was already used." }); });
                                connection.commit(commitError => { connection.release(); if (commitError) return res.status(500).json({ valid: false, message: "RFID registration could not be committed." }); res.json({ valid: true, registration: true, message: "Student Registered Successfully" }); });
                            });
                        });
                    });
                });
            });
            return;
        }
        db.query("SELECT * FROM users WHERE rfid_uid=? LIMIT 1", [uid], (err, rows) => {
            if (err) return res.status(500).json({ valid: false, message: "Student verification is unavailable." });
            if (!rows.length || String(rows[0].role || "").toLowerCase() !== "student" || String(rows[0].account_status || "ACTIVE").toUpperCase() !== "ACTIVE") return res.status(200).json({ valid: false, message: "Invalid or inactive Student Card. Access denied." });
            res.json({ valid: true, registration: false, message: "Student verified.", student: { user_id: rows[0].user_id, name: rows[0].name, student_id: rows[0].student_id } });
        });
    });
});

// The physical condition buttons can only annotate a pending return selected in the authenticated web flow.
app.post("/api/kiosk/return-condition", verifyKioskKey, (req, res) => {
    const uid = String((req.body || {}).uid || "").replace(/[\\s:-]/g, "").toUpperCase();
    const condition = String((req.body || {}).condition || "").toUpperCase();
    if (!/^[0-9A-F]{4,32}$/.test(uid) || !["GOOD","DAMAGED","MISSING_PARTS"].includes(condition)) return res.status(400).json({ message: "Valid student UID and return condition are required." });
    db.query("SELECT * FROM users WHERE rfid_uid=? AND LOWER(role)='student' LIMIT 1", [uid], (userError, users) => {
        if (userError || !users.length || String(users[0].account_status || "ACTIVE").toUpperCase() !== "ACTIVE") return res.status(userError ? 500 : 403).json({ message: "Student card is not registered or is inactive." });
        db.query("SELECT s.return_session_id FROM return_sessions s JOIN return_session_items i ON i.return_session_id=s.return_session_id WHERE s.user_id=? AND s.status='PENDING' AND i.condition_status IS NULL ORDER BY s.created_at ASC,i.return_session_item_id ASC LIMIT 1", [users[0].user_id], (sessionError, sessions) => {
            if (sessionError || !sessions.length) return res.status(sessionError ? 500 : 409).json({ message: "No pending return item is waiting for condition feedback." });
            db.query("UPDATE return_session_items SET condition_status=? WHERE return_session_id=? AND condition_status IS NULL ORDER BY return_session_item_id ASC LIMIT 1", [condition,sessions[0].return_session_id], updateError => {
                if (updateError) return res.status(500).json({ message: "Could not save return condition." });
                res.json({ message: "Return condition saved.", condition });
            });
        });
    });
});

app.post("/api/kiosk/scan", verifyKioskKey, (req, res) => {
    const { student_rfid, equipment_rfid } = req.body;

    if (!student_rfid || !equipment_rfid) {
        return res.status(400).json({ message: "Student RFID and Equipment RFID are required." });
    }

    db.query("SELECT user_id, name, student_id FROM users WHERE rfid_uid = ?", [student_rfid.trim()], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        if (users.length === 0) {
            return res.status(404).json({ message: "Student RFID card not registered." });
        }

        const user = users[0];

        db.query("SELECT equipment_id, equipment_code, name, status, available_quantity FROM equipment WHERE rfid_tag = ?", [equipment_rfid.trim()], (err, equipmentList) => {
            if (err) return res.status(500).json({ error: err.message });
            if (equipmentList.length === 0) {
                return res.status(404).json({ message: "Equipment RFID tag not found." });
            }

            const equipment = equipmentList[0];

            db.query("SELECT transaction_id FROM transactions WHERE user_id = ? AND equipment_id = ? AND status = 'ACTIVE'", [user.user_id, equipment.equipment_id], (err, activeTxs) => {
                if (err) return res.status(500).json({ error: err.message });

                if (activeTxs.length > 0) {
                    // PROCESS RETURN
                    const transactionId = activeTxs[0].transaction_id;
                    db.query("UPDATE transactions SET status = 'RETURNED', return_time = NOW() WHERE transaction_id = ?", [transactionId], (err) => {
                        if (err) return res.status(500).json({ error: err.message });

                        db.query("UPDATE equipment SET available_quantity = LEAST(COALESCE(total_quantity, 50), COALESCE(available_quantity, 0) + 1), status = 'AVAILABLE' WHERE equipment_id = ?", [equipment.equipment_id], (err) => {
                            if (err) return res.status(500).json({ error: err.message });

                            res.json({
                                action: "RETURN",
                                message: `Return successful for ${user.name} (${equipment.name})`
                            });
                        });
                    });
                } else {
                    // PROCESS CHECKOUT
                    if (equipment.status === "MAINTENANCE" || equipment.status === "LOST" || (equipment.available_quantity ?? 50) <= 0) {
                        return res.status(400).json({ message: "Equipment is out of stock or under maintenance." });
                    }

                    db.query("INSERT INTO transactions (user_id, equipment_id, status) VALUES (?, ?, 'ACTIVE')", [user.user_id, equipment.equipment_id], (err, result) => {
                        if (err) return res.status(500).json({ error: err.message });

                        db.query(
                            `UPDATE equipment
                             SET available_quantity = GREATEST(0, COALESCE(available_quantity, 50) - 1),
                                 status = CASE WHEN (COALESCE(available_quantity, 50) - 1) <= 0 THEN 'IN_USE' ELSE 'AVAILABLE' END
                             WHERE equipment_id = ?`,
                            [equipment.equipment_id],
                            (err) => {
                                if (err) return res.status(500).json({ error: err.message });

                                res.json({
                                    action: "CHECKOUT",
                                    message: `Checkout successful for ${user.name} (${equipment.name})`
                                });
                            }
                        );
                    });
                }
            });
        });
    });
});

// Get active checkouts for a specific user
app.get("/api/transactions/user/:user_id", authenticateToken, (req, res) => {
    const requestedUserId = String(req.params.user_id);
    const isAdmin = String(req.user.role || "").toLowerCase() === "admin";
    if (!isAdmin && requestedUserId !== String(req.user.user_id)) {
        return res.status(403).json({ message: "Transaction access denied." });
    }
    const history = String(req.query.history || "").toLowerCase() === "true";
    const statusClause = history ? "" : "AND t.status = 'ACTIVE'";
    const sql = "SELECT t.transaction_id, t.equipment_id, e.equipment_code, e.name AS equipment_name, t.checkout_time, t.return_time, t.status " +
        "FROM transactions t LEFT JOIN equipment e ON e.equipment_id = t.equipment_id WHERE t.user_id = ? " + statusClause +
        " ORDER BY t.transaction_id DESC";
    db.query(sql, [requestedUserId], (err, results) => {
        if (err) {
            console.error("User transactions request failed:", err.message);
            return res.status(500).json({ message: "Could not load transactions." });
        }
        res.json(results);
    });
});

// Transaction history API
app.get("/api/transactions", authenticateToken, requireAdmin, (req, res) => {
    console.log("API /api/transactions requested");
    const sql = `
        SELECT
            t.transaction_id,
            u.name AS student_name,
            u.student_id,
            e.equipment_code,
            e.name AS equipment_name,
            t.checkout_time,
            t.return_time,
            t.status
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.user_id
        LEFT JOIN equipment e ON t.equipment_id = e.equipment_id
        ORDER BY t.transaction_id DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("Database error in /api/transactions:", err.message);
            return res.status(500).json({ error: err.message });
        }

        console.log(`Found ${results.length} transactions`);
        res.json(results);
    });
});

// Admin API: Get student account details & transaction history by student_id
app.get("/api/admin/student/:student_id", authenticateToken, requireAdmin, (req, res) => {
    const studentId = req.params.student_id;

    const userSql = "SELECT user_id, name, student_id, email, role FROM users WHERE student_id = ?";

    db.query(userSql, [studentId], (err, users) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        if (users.length === 0) {
            return res.status(404).json({ message: "Student not found with ID: " + studentId });
        }

        const user = users[0];

        const txSql = `
            SELECT
                t.transaction_id,
                e.equipment_id,
                e.equipment_code,
                e.name AS equipment_name,
                t.checkout_time,
                t.return_time,
                t.status
            FROM transactions t
            LEFT JOIN equipment e ON t.equipment_id = e.equipment_id
            WHERE t.user_id = ?
            ORDER BY t.transaction_id DESC
        `;

        db.query(txSql, [user.user_id], (err, transactions) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }

            res.json({
                student: user,
                transactions: transactions
            });
        });
    });
});

// Start server — keep this at the bottom
const PORT = Number(process.env.PORT) || 3000;

app.post("/api/equipment", authenticateToken, requireAdmin, (req, res) => {
    const {
        equipment_code,
        name,
        category,
        rfid_tag,
        calibration_limit
    } = req.body;

    if (
        !equipment_code ||
        !name ||
        !category ||
        !rfid_tag
    ) {
        return res.status(400).json({
            message: "Please fill in all required fields."
        });
    }

    const qrToken = crypto.randomBytes(16).toString("hex");
    const sql = `
        INSERT INTO equipment
        (equipment_code, name, category, rfid_tag, qr_token,
         status, runtime_hours, calibration_limit, total_quantity, available_quantity)
        VALUES (?, ?, ?, ?, ?, 'AVAILABLE', 0, ?, ?, ?)
    `;

    const quantity = Number.isSafeInteger(Number(req.body.total_quantity)) && Number(req.body.total_quantity) >= 1 && Number(req.body.total_quantity) <= 100000 ? Number(req.body.total_quantity) : 1;
    const values = [
        equipment_code,
        name,
        category,
        rfid_tag,
        qrToken,
        calibration_limit || 500,
        quantity,
        quantity
    ];

    db.query(sql, values, (error, result) => {
        if (error) {
            console.error("Add equipment error:", error);

            if (error.code === "ER_DUP_ENTRY") {
                return res.status(409).json({
                    message:
                        "Equipment code or RFID tag already exists."
                });
            }

            return res.status(500).json({
                message: "Could not add equipment."
            });
        }

        res.status(201).json({
            message: "Equipment added successfully!",
            equipment_id: result.insertId
        });
    });
});
app.use(express.static(FRONTEND_DIST));
app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ message: "API route not found." });
    const indexPath = path.join(FRONTEND_DIST, "index.html");
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    next();
});
app.listen(PORT, () => {
    console.log("LEMS API running on port " + PORT);
});