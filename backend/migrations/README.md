# Database inspection and migrations

The app must not modify the LEMS database automatically when it starts. The original backend altered schema and changed equipment quantities/statuses at startup; that behavior has been removed.

## Before migrating

1. Export/backup the local lems_db schema and data in MySQL Workbench.
2. Confirm the export contains the users, equipment, transactions, and (if used) complaints tables.
3. In Railway, use the MySQL service's variable references for the app; do not copy database credentials to source control.
4. Import the schema and records deliberately into the database selected by MYSQLDATABASE. Do not import into an unknown database without a backup.
5. Run the read-only schema checker (npm run db:check) using environment variables for the database being inspected.

The checker verifies table/column names only. It does not migrate, alter, or delete data. It exits with code 2 if required schema pieces are missing.

## Expected API fields

- users: user_id, name, student_id, email, password, role, reset_token, reset_token_expires
- equipment: equipment_id, equipment_code, name, category, rfid_tag, status, runtime_hours, calibration_limit, total_quantity, available_quantity
- transactions: transaction_id, user_id, equipment_id, checkout_time, return_time, status
- complaints: complaint_id, user_id, equipment_id, issue_description, status, created_at

These are required-field checks, not instructions to blindly add columns. Compare missing items against the actual local schema and data meaning before writing versioned SQL; do not reset availability counts or replace existing IDs/relationships.

## Administrator setup

No default admin or default password is inserted on startup. First import existing users or create an account through signup, then promote an intentional account and set its new password using the backend admin:provision script. It requires ADMIN_STUDENT_ID and ADMIN_NEW_PASSWORD (12-128 characters), refuses to proceed if the student ID is missing/ambiguous, and never prints the password. Run only against the intended backed-up database from a machine with secure database connectivity. Do not commit temporary variables.
