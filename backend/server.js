
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
        calibration_limit
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
            calibration_limit = ?
        WHERE equipment_id = ?
    `;

    const values = [
        equipment_code,
        name,
        category,
        rfid_tag,
        status,
        calibration_limit || 500,
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

// Sign Up / Registration API
app.post("/api/signup", loginLimiter, (req, res) => {
    const { name, student_id, email, password } = req.body || {};
    if (!name || !student_id || !email || !password) return res.status(400).json({ message: "Name, student ID, email, and password are required." });
    if (String(password).length < 8 || String(password).length > 128) return res.status(400).json({ message: "Password must be between 8 and 128 characters." });
    const cleanName = String(name).trim();
    const cleanStudentId = String(student_id).trim();
    const cleanEmail = String(email).trim().toLowerCase();
    if (!cleanName || !cleanStudentId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ message: "Enter a valid name, student ID, and email." });
    db.query("SELECT user_id FROM users WHERE student_id = ? OR email = ?", [cleanStudentId, cleanEmail], (err, rows) => {
        if (err) {
            console.error("Signup check failed:", err.message);
            return res.status(500).json({ message: "Could not create the account right now." });
        }
        if (rows.length) return res.status(409).json({ message: "An account with that student ID or email already exists." });
        bcrypt.hash(String(password), 12, (hashError, passwordHash) => {
            if (hashError) return res.status(500).json({ message: "Could not secure the password." });
            db.query("INSERT INTO users (name, student_id, email, password, role) VALUES (?, ?, ?, ?, 'student')",
                [cleanName, cleanStudentId, cleanEmail, passwordHash], (insertError) => {
                    if (insertError) {
                        if (insertError.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "An account with that student ID or email already exists." });
                        console.error("Signup insert failed:", insertError.message);
                        return res.status(500).json({ message: "Could not create the account right now." });
                    }
                    res.status(201).json({ message: "Account created successfully. You can now sign in." });
                });
        });
    });
});

app.post("/api/login", loginLimiter, (req, res) => {
    const { student_id, password } = req.body || {};
    if (!student_id || !password) return res.status(400).json({ message: "Student ID and password are required." });
    db.query("SELECT user_id, name, student_id, email, role, password FROM users WHERE student_id = ? LIMIT 1",
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
                role: String(row.role || "student").toLowerCase()
            };
            const token = jwt.sign(
                { user_id: user.user_id, student_id: user.student_id, role: user.role },
                JWT_SECRET,
                { expiresIn: "8h", issuer: "lems-api", audience: "lems-app" }
            );
            res.json({ message: "Login successful", user, token });
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

// Checkout equipment API
app.post("/api/checkout", authenticateToken, (req, res) => {
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
                                             status = CASE WHEN (COALESCE(available_quantity, 50) - 1) <= 0 THEN 'OUT_OF_STOCK' ELSE 'AVAILABLE' END
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

// Return equipment API
app.post("/api/return", authenticateToken, (req, res) => {
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
                                 status = CASE WHEN (COALESCE(available_quantity, 50) - 1) <= 0 THEN 'OUT_OF_STOCK' ELSE 'AVAILABLE' END
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


// Partial-return workflow: students request selected active transaction IDs; only admins confirm physical handover.
app.post("/api/return-batches", authenticateToken, (req, res) => {
    const userId = Number(req.user.user_id);
    const ids = Array.isArray((req.body || {}).transaction_ids)
        ? [...new Set(req.body.transaction_ids.map(Number).filter(Number.isInteger))]
        : [];
    if (!Number.isInteger(userId) || userId <= 0 || ids.length === 0 || ids.some(id => id <= 0)) {
        return res.status(400).json({ message: "Select at least one valid active item to return." });
    }
    const barcode = "RET-" + crypto.randomBytes(9).toString("hex").toUpperCase();
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Could not start a return request." });
        connection.beginTransaction(beginError => {
            if (beginError) {
                connection.release();
                return res.status(500).json({ message: "Could not start a return request." });
            }
            const placeholders = ids.map(() => "?").join(",");
            connection.query(
                "SELECT t.transaction_id FROM transactions t WHERE t.user_id = ? AND t.status = 'ACTIVE' AND t.transaction_id IN (" + placeholders + ") FOR UPDATE",
                [userId, ...ids],
                (selectError, rows) => {
                    if (selectError || rows.length !== ids.length) {
                        return connection.rollback(() => {
                            connection.release();
                            res.status(selectError ? 500 : 409).json({ message: selectError ? "Could not validate selected items." : "One or more selected items are no longer active checkouts." });
                        });
                    }
                    connection.query(
                        "SELECT rbi.transaction_id FROM return_batch_items rbi JOIN return_batches rb ON rb.return_batch_id = rbi.return_batch_id WHERE rb.status = 'PENDING' AND rbi.transaction_id IN (" + placeholders + ")",
                        ids,
                        (reservedError, reserved) => {
                            if (reservedError || reserved.length) {
                                return connection.rollback(() => {
                                    connection.release();
                                    res.status(reservedError ? 500 : 409).json({ message: reservedError ? "Could not check existing return requests." : "One or more selected items are already awaiting admin confirmation." });
                                });
                            }
                            connection.query(
                                "INSERT INTO return_batches (barcode, user_id, status, created_at) VALUES (?, ?, 'PENDING', NOW())",
                                [barcode, userId],
                                (batchError, batchResult) => {
                                    if (batchError) {
                                        return connection.rollback(() => {
                                            connection.release();
                                            res.status(500).json({ message: "Could not create the return request." });
                                        });
                                    }
                                    const values = ids.map(id => [batchResult.insertId, id]);
                                    connection.query(
                                        "INSERT INTO return_batch_items (return_batch_id, transaction_id) VALUES ?",
                                        [values],
                                        itemError => {
                                            if (itemError) {
                                                return connection.rollback(() => {
                                                    connection.release();
                                                    res.status(500).json({ message: "Could not save selected return items." });
                                                });
                                            }
                                            connection.commit(commitError => {
                                                connection.release();
                                                if (commitError) return res.status(500).json({ message: "Could not save the return request." });
                                                res.status(201).json({ message: "Return request created. Show this barcode to the administrator.", barcode, item_count: ids.length, status: "PENDING" });
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        });
    });
});

app.get("/api/return-batches/mine", authenticateToken, (req, res) => {
    db.query(
        "SELECT rb.return_batch_id, rb.barcode, rb.status, rb.created_at, rb.confirmed_at, COUNT(rbi.transaction_id) AS item_count FROM return_batches rb LEFT JOIN return_batch_items rbi ON rbi.return_batch_id = rb.return_batch_id WHERE rb.user_id = ? GROUP BY rb.return_batch_id ORDER BY rb.return_batch_id DESC",
        [req.user.user_id],
        (err, rows) => {
            if (err) {
                if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ message: "Return workflow database migration has not been applied yet." });
                return res.status(500).json({ message: "Could not load your return requests." });
            }
            res.json(rows);
        }
    );
});

app.get("/api/return-batches/pending", authenticateToken, requireAdmin, (req, res) => {
    db.query(
        "SELECT rb.return_batch_id, rb.barcode, rb.user_id, u.name AS student_name, u.student_id, rb.created_at, COUNT(rbi.transaction_id) AS item_count FROM return_batches rb JOIN users u ON u.user_id = rb.user_id JOIN return_batch_items rbi ON rbi.return_batch_id = rb.return_batch_id WHERE rb.status = 'PENDING' GROUP BY rb.return_batch_id ORDER BY rb.created_at ASC",
        (err, rows) => {
            if (err) {
                if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ message: "Return workflow database migration has not been applied yet." });
                return res.status(500).json({ message: "Could not load pending return requests." });
            }
            res.json(rows);
        }
    );
});

app.post("/api/return-batches/:barcode/confirm", authenticateToken, requireAdmin, (req, res) => {
    const barcode = String(req.params.barcode || "").trim().toUpperCase();
    if (!/^RET-[A-F0-9]{18}$/.test(barcode)) return res.status(400).json({ message: "Enter a valid return barcode." });
    db.getConnection((connectionError, connection) => {
        if (connectionError) return res.status(500).json({ message: "Could not start return confirmation." });
        connection.beginTransaction(beginError => {
            if (beginError) {
                connection.release();
                return res.status(500).json({ message: "Could not start return confirmation." });
            }
            connection.query("SELECT return_batch_id, user_id, status FROM return_batches WHERE barcode = ? FOR UPDATE", [barcode], (batchError, batches) => {
                if (batchError || !batches.length || batches[0].status !== "PENDING") {
                    return connection.rollback(() => {
                        connection.release();
                        res.status(batchError ? 500 : 409).json({ message: batchError ? "Could not look up that barcode." : "Barcode not found or this return batch has already been confirmed." });
                    });
                }
                const batch = batches[0];
                connection.query(
                    "SELECT t.transaction_id, t.equipment_id FROM return_batch_items rbi JOIN transactions t ON t.transaction_id = rbi.transaction_id WHERE rbi.return_batch_id = ? AND t.user_id = ? AND t.status = 'ACTIVE' FOR UPDATE",
                    [batch.return_batch_id, batch.user_id],
                    (itemsError, items) => {
                        if (itemsError || !items.length) {
                            return connection.rollback(() => {
                                connection.release();
                                res.status(itemsError ? 500 : 409).json({ message: itemsError ? "Could not validate return items." : "No active items remain in this return batch." });
                            });
                        }
                        connection.query(
                            "UPDATE transactions t JOIN return_batch_items rbi ON rbi.transaction_id = t.transaction_id SET t.status = 'RETURNED', t.return_time = NOW() WHERE rbi.return_batch_id = ? AND t.user_id = ? AND t.status = 'ACTIVE'",
                            [batch.return_batch_id, batch.user_id],
                            updateError => {
                                if (updateError) {
                                    return connection.rollback(() => {
                                        connection.release();
                                        res.status(500).json({ message: "Could not mark items as returned." });
                                    });
                                }
                                const counts = new Map();
                                for (const item of items) counts.set(Number(item.equipment_id), (counts.get(Number(item.equipment_id)) || 0) + 1);
                                const entries = [...counts.entries()];
                                const updateEquipment = index => {
                                    if (index >= entries.length) {
                                        return connection.query(
                                            "UPDATE return_batches SET status = 'CONFIRMED', confirmed_at = NOW(), confirmed_by = ? WHERE return_batch_id = ? AND status = 'PENDING'",
                                            [req.user.user_id, batch.return_batch_id],
                                            (confirmError, confirmResult) => {
                                                if (confirmError || confirmResult.affectedRows !== 1) {
                                                    return connection.rollback(() => {
                                                        connection.release();
                                                        res.status(500).json({ message: "Could not finalize return confirmation." });
                                                    });
                                                }
                                                connection.commit(commitError => {
                                                    connection.release();
                                                    if (commitError) return res.status(500).json({ message: "Return confirmation could not be saved." });
                                                    res.json({ message: "Return confirmed. Selected items have been checked in.", barcode, item_count: items.length, status: "CONFIRMED" });
                                                });
                                            }
                                        );
                                    }
                                    const [equipmentId, quantity] = entries[index];
                                    connection.query(
                                        "UPDATE equipment SET available_quantity = LEAST(COALESCE(total_quantity, 50), COALESCE(available_quantity, 0) + ?), status = CASE WHEN status IN ('MAINTENANCE', 'LOST') THEN status ELSE 'AVAILABLE' END WHERE equipment_id = ?",
                                        [quantity, equipmentId],
                                        (stockError, stockResult) => {
                                            if (stockError || stockResult.affectedRows !== 1) {
                                                return connection.rollback(() => {
                                                    connection.release();
                                                    res.status(500).json({ message: "Could not update returned equipment stock." });
                                                });
                                            }
                                            updateEquipment(index + 1);
                                        }
                                    );
                                };
                                updateEquipment(0);
                            }
                        );
                    }
                );
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

    const sql = `
        INSERT INTO equipment
        (equipment_code, name, category, rfid_tag,
         status, runtime_hours, calibration_limit)
        VALUES (?, ?, ?, ?, 'AVAILABLE', 0, ?)
    `;

    const values = [
        equipment_code,
        name,
        category,
        rfid_tag,
        calibration_limit || 500
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