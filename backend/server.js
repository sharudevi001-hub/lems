
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
        const equipment = rows[0];
        if (String(req.user.role || "").toLowerCase() !== "admin" &&
            (String(equipment.status || "").toUpperCase() !== "AVAILABLE" || Number(equipment.available_quantity) < 1)) {
            return res.status(409).json({ message: "This equipment unit is not available for checkout." });
        }
        res.json({ equipment });
    });
});

// Complaint selection is separate from checkout inventory: students must be
// able to report a fault against any exact physical unit, including unavailable
// or currently borrowed units. Only the unit's unique code and name are exposed.
app.get("/api/equipment/complaint-options", authenticateToken, (req, res) => {
    db.query(
        "SELECT equipment_id, equipment_code, name, category, status FROM equipment ORDER BY name, equipment_code",
        (err, rows) => {
            if (err) return res.status(500).json({ message: "Could not load equipment complaint options." });
            res.json(rows);
        }
    );
});

// Administrators can review every unit. Students only receive equipment
// records that are currently eligible for checkout.
app.get("/api/equipment", authenticateToken, (req, res) => {
    const isAdmin = String(req.user.role || "").toLowerCase() === "admin";
    const sql = isAdmin
        ? "SELECT * FROM equipment ORDER BY name, equipment_code"
        : "SELECT * FROM equipment WHERE status = 'AVAILABLE' AND COALESCE(available_quantity, 1) > 0 ORDER BY name, equipment_code";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
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

    if (!equipment_code || !name || !category) {
        return res.status(400).json({
            message: "Equipment code, name, and category are required. RFID can be linked later."
        });
    }

    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
            message: "Invalid equipment status."
        });
    }

    const updateUnit = () => {
        const sql = `
            UPDATE equipment
            SET equipment_code = ?, name = ?, category = ?, rfid_tag = ?,
                status = ?, calibration_limit = ?,
                total_quantity = 1,
                available_quantity = CASE WHEN ? = 'AVAILABLE' THEN 1 ELSE 0 END
            WHERE equipment_id = ?
        `;
        db.query(sql, [equipment_code, name, category, String(rfid_tag || "").trim() || null, status, calibration_limit || 500, status, id], (error, result) => {
            if (error) {
                console.error("Update equipment error:", error);
                return res.status(error.code === "ER_DUP_ENTRY" ? 409 : 500).json({ message: error.code === "ER_DUP_ENTRY" ? "Equipment code or RFID tag already exists." : "Could not update equipment." });
            }
            if (!result.affectedRows) return res.status(404).json({ message: "Equipment not found." });
            return res.json({ message: "Individual equipment unit updated successfully." });
        });
    };

    if (status !== "AVAILABLE") return updateUnit();
    db.query(
        "SELECT (SELECT COUNT(*) FROM transactions WHERE equipment_id = ? AND status = 'ACTIVE') AS active_count, (SELECT COUNT(*) FROM complaints WHERE equipment_id = ? AND status NOT IN ('RESOLVED','REJECTED')) AS open_count",
        [id, id],
        (checkError, rows) => {
            if (checkError) return res.status(500).json({ message: "Could not verify unit availability." });
            if (Number(rows[0]?.active_count || 0) > 0 || Number(rows[0]?.open_count || 0) > 0) {
                return res.status(409).json({ message: "This unit has an active loan or unresolved maintenance report. It cannot be marked available." });
            }
            updateUnit();
        }
    );
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

// Admin-only student directory.
// Uses the existing users.rfid_uid column; no additional table or migration is required.
app.get("/api/admin/students", authenticateToken, requireAdmin, (req, res) => {
    const sql = "SELECT * FROM users WHERE LOWER(role) = 'student' ORDER BY name ASC";

    db.query(sql, (err, rows) => {
        if (err) {
            console.error("Student directory query failed:", err.message);
            return res.status(500).json({ message: "Could not load students." });
        }
        return res.json({ students: rows.map(({ password, reset_token, reset_token_expires, ...row }) => ({ ...row, account_status: row.account_status || "ACTIVE" })) });
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

app.post("/api/equipment", authenticateToken, requireAdmin, (req, res) => {
    const { equipment_code, name, category, calibration_limit } = req.body || {};
    const quantity = Number(req.body?.total_quantity ?? 1);
    if (!equipment_code || !name || !category) {
        return res.status(400).json({ message: "Equipment code, name and category are required." });
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
        return res.status(400).json({ message: "Quantity must be a whole number between 1 and 1000." });
    }
    const baseCode = String(equipment_code).trim();
    
    const limit = Number(calibration_limit) > 0 ? Number(calibration_limit) : 500;
    const values = Array.from({ length: quantity }, (_, index) => {
        const suffix = String(index + 1).padStart(3, "0");
        const code = quantity === 1 ? baseCode : baseCode + "-" + suffix;
        return [code, name, category, crypto.randomBytes(16).toString("hex"), limit];
    });
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Could not add equipment units." });
        connection.beginTransaction(beginError => {
            if (beginError) { connection.release(); return res.status(500).json({ message: "Could not start equipment creation." }); }
            connection.query(
                "INSERT INTO equipment (equipment_code,name,category,qr_token,status,runtime_hours,calibration_limit,total_quantity,available_quantity) VALUES ?",
                [values.map(row => [...row, "AVAILABLE", 0, row[4], 1, 1])],
                (insertError, result) => {
                    if (insertError) return connection.rollback(() => {
                        connection.release();
                        res.status(insertError.code === "ER_DUP_ENTRY" ? 409 : 500).json({ message: insertError.code === "ER_DUP_ENTRY" ? "Equipment code already exists. Choose a new base code." : "Could not add equipment units." });
                    });
                    connection.commit(commitError => {
                        connection.release();
                        if (commitError) return res.status(500).json({ message: "Equipment units could not be saved." });
                        res.status(201).json({ message: quantity + " individual equipment unit(s) added successfully.", first_equipment_id: result.insertId, units_created: quantity });
                    });
                }
            );
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