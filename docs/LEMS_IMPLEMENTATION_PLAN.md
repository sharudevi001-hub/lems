# LEMS Full-Spec Implementation Plan

This plan tracks implementation of the supplied complete LEMS project prompt while preserving the existing Railway production deployment and database.

## Safety rules
- Work only on `lems/full-spec-staged-implementation`; do not merge or deploy to production without explicit approval.
- Do not run schema-changing SQL against Railway during implementation.
- Reuse the existing `users.rfid_uid` column; do not add a duplicate RFID table.
- Never commit production credentials, JWT secrets, kiosk keys, or raw QR/RFID authorization tokens.
- A feature is not complete until API/UI behavior and acceptance scenarios are tested.

## Existing Railway schema confirmed by the project owner
- `users`: `user_id`, `name`, `student_id`, `email`, `password`, `role`, `reset_token`, `reset_token_expires`, `rfid_uid`, `created_at`, `must_change_password`.
- `equipment`, `complaints`, `tanscation` and additional checkout/return tables also exist.
- `users.rfid_uid` is nullable and has a unique index, so it supports one card UID per account and rejects duplicates.
- The RFID linking routes use this existing column. No RFID schema migration is required for this flow.

## Current implementation on this branch
- Admin-only student creation and student directory.
- Admin-only RFID UID linking with input validation and duplicate-UID error handling.
- Login, change-password/first-login support, forgot/reset password flows.
- Equipment listing and admin inventory CRUD.
- Checkout-request QR verification/issue and return-QR verification/confirmation endpoints and admin UI.
- Complaint listing, submission, and resolution.
- Transaction history views for admins and students.

## Remaining work before release
1. Run a clean backend/frontend build and resolve any failures.
2. Test the student create/list/RFID-link flow against a disposable test database with the same schema; verify duplicate UID rejection.
3. Verify checkout and return requests against the actual Railway schema using a safe staging database, including quantities, partial returns, damaged-item handling and concurrency.
4. Complete the hardware kiosk flow (ESP32 DevKit + MFRC522 + SSD1306 OLED + feedback buttons), authenticated backend communication, and setup/wiring documentation.
5. Confirm phone-camera QR scanning and manual-entry fallback on a real mobile device.
6. Run the acceptance checklist from the full project prompt and document pass/fail evidence.
7. Review the final diff and request explicit approval before merging/deploying.

## Release status
This is a staged feature branch, not a production release. No production database migration or deployment is authorized by this plan.
