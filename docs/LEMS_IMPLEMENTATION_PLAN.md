# LEMS Full-Spec Implementation and Safe Setup

This document tracks the supplied project prompt against the existing repository. The existing React/Express/MySQL application is reused; no parallel frontend or duplicate users/equipment tables are introduced.

## Implemented in the feature branch

- Admin-only student creation, directory, RFID UID linking, activate/deactivate controls, department/year/section fields, and a 3-minute admin-authorized RFID tap registration session.
- Login, password reset, first-login password change, and role-protected API routes.
- Equipment inventory CRUD, stock quantity fields, opaque equipment QR tokens and admin QR labels.
- Student quantity cart with a single checkout QR. Backend locks stock rows, validates quantities, inserts one transaction row per physical unit, decrements stock in a DB transaction, and prevents reusing a checkout QR.
- Student selection of individual active unit transactions for partial return using one batch return QR. Backend return confirmation is transactional and updates only selected units.
- Phone camera QR/barcode scanner where the browser supports the native BarcodeDetector API, with manual token entry fallback.
- Return condition records, kiosk endpoints for RFID verification and three physical condition buttons, student complaint history, complaint category selector, and expanded admin inventory/student/complaint metrics.
- ESP32 firmware and wiring documentation for MFRC522, SSD1306 OLED, Wi-Fi and the three feedback buttons.
- Read-only database schema checker.

## Important deployment state

The frontend production build passed on Railway and the backend started successfully in a successful deployment. That proves the app builds and starts, not that all acceptance tests pass.

The additive database migration `backend/migrations/20261028_quantity_partial_returns.sql` is **not automatically executed by the app**. Quantity checkout, equipment QR labels, batch returns, academic profile fields and RFID tap-registration sessions require this migration. Do not claim those workflows are live until the schema check and end-to-end tests pass.

## Apply the migration safely

1. Open MySQL Workbench and connect to the existing Railway MySQL database.
2. Select the existing `lems_db` schema. Before changing it, use **Server → Data Export** to create a backup.
3. Inspect `backend/migrations/20261028_quantity_partial_returns.sql`. It is an additive, one-time migration: it adds columns and new tables and backfills existing equipment QR tokens. Do not run it a second time; the ALTER statements are intentionally not repeatable.
4. Run the migration once against the intended database. Preserve all existing rows; do not drop or recreate tables.
5. On a machine with the repository checked out, configure backend environment variables for that same database and run:

   ```powershell
   cd "D:\lems project\backend"
   npm install
   npm run db:check
   ```

6. Resolve any missing-column/table report before using the new workflows. Never paste database passwords, JWT secrets or kiosk keys into GitHub.
7. Test student creation and RFID registration, checkout of 4 units from stock 25 (expected available stock 21), partial return of 2 units (expected available stock 23 and 2 still outstanding), damaged-item maintenance status, and repeated QR/button submissions.
8. Only after those checks pass should the deployment be treated as release-ready.

## Local build commands

From the repository root in PowerShell:

```powershell
cd "D:\lems project\backend"
npm install
node --check server.js
cd ..\frontend-react
npm install
npm run build
```

Use the actual repository folder if it is not `D:\lems project`.

## ESP32 setup

See [HARDWARE_SETUP.md](HARDWARE_SETUP.md). Copy `firmware/esp32-kiosk/secrets.example.h` to a local `secrets.h`, set Wi-Fi/API/kiosk credentials, and replace the placeholder CA certificate with the certificate that validates the HTTPS endpoint. Never commit the real secrets file. Install MFRC522, Adafruit SSD1306 and Adafruit GFX through Arduino Library Manager.

## Remaining acceptance work

- Apply the reviewed migration to a backed-up test/staging database, then run `npm run db:check`.
- Verify each API against the real schema, including duplicate RFID rejection, stock concurrency, repeat submissions and damaged/missing-part returns.
- Test camera scanning on an Android phone and fallback entry in a browser without BarcodeDetector.
- Verify the physical ESP32 buttons, OLED state transitions and Wi-Fi failure behavior on the actual hardware.
- Confirm production migration and runtime configuration before declaring every acceptance criterion passed.