# LEMS Full-Spec Implementation Plan

This plan follows the supplied COMPLETE PROJECT DEVELOPMENT PROMPT. Implement in small, testable changes and preserve the current production deployment and existing database records.

## Safety rules
- Work on `lems/full-spec-staged-implementation`; do not merge or deploy to production without explicit approval.
- Inspect current schema and routes before changing them.
- Prefer additive migrations; do not create duplicate tables when an equivalent table exists.
- Never commit production credentials, kiosk keys, JWT secrets, or raw QR/RFID authorization tokens.
- A feature is not complete until its API/UI path and acceptance scenario have been tested.

## Stage 1 — Existing system and schema audit
- Verify environment variable names and database connection configuration without exposing secret values.
- Inventory current tables, columns, indexes, foreign keys, routes, and frontend pages.
- Check migrations against the actual Railway schema; document safe additive migrations.
- Confirm health endpoint and login, role authorization, and first-login password change.

## Stage 2 — Student registration and RFID linking
- Admin-only student creation with name, roll/student ID, department, year/section, email, status, and initial password.
- Add unique RFID UID association and duplicate-UID rejection.
- Add an authorized registration session so an ESP32 UID cannot be linked by an unauthenticated request.
- Store only the association in MySQL; the backend must validate active student status.

## Stage 3 — ESP32 and OLED integration
- Document wiring and firmware for ESP32 DevKit, MFRC522, SSD1306 OLED, and three feedback buttons.
- Add authenticated kiosk endpoints for card verification and return-condition submissions.
- Show backend verification outcomes on the OLED; handle timeouts and Wi-Fi/API failures.
- Keep kiosk secrets out of firmware source control and do not treat a UID alone as authorization.

## Stage 4 — Equipment inventory and mobile scanning
- Reuse existing equipment tables and add unit-level tracking only where required.
- Add unique opaque QR tokens for individually tracked units.
- Implement phone-camera QR/barcode scanning with manual code entry fallback.
- Maintain stock movement history and calibration/maintenance status.

## Stage 5 — Checkout cart and transaction safety
- Support multiple equipment types and quantities.
- Validate current student identity, stock, and quantity on the backend.
- Use database transactions and conditional updates/locking to prevent overselling.
- Issue a unique checkout confirmation token and show the transaction to student and admin.

## Stage 6 — Partial returns and condition feedback
- Return selected quantities against the original active checkout.
- Prevent returns greater than the outstanding quantity.
- Record unique return confirmation and condition report.
- Mark damaged or incomplete equipment for inspection/maintenance rather than available.

## Stage 7 — Complaints and dashboards
- Student complaint submission, history, status, admin response, and optional safe photo uploads.
- Admin pages for students/RFID, equipment/stock, checkout/returns, condition reports, complaints, history, and reports.
- Student pages for profile, availability, cart, borrowed items, returns, history, and complaints.

## Stage 8 — End-to-end testing and release
- Test all 20 acceptance scenarios from the supplied prompt.
- Verify migrations on a safe database before production.
- Review changed files and deployment configuration.
- Request explicit approval before merging or deploying.

## Current baseline observations
- Repository: `sharudevi001-hub/lems`.
- Existing application branch inspected: `railway/react-migration`.
- Backend already reads Railway `MYSQL*` environment variables and has login, password-change, equipment, and checkout-related code.
- The `users.must_change_password` migration exists. Confirm it is present in the Railway database before further login/schema changes.
- This plan is a roadmap, not a claim that all listed features are implemented.
