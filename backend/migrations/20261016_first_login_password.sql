-- Run once against the LEMS database before deploying this branch.
-- Existing accounts keep normal login; new admin-created students are flagged by the API.
ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0;
