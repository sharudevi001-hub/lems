-- LEMS checkout issue schema repair.
-- Safe to run more than once. This migration does not delete or rewrite existing transactions.
-- Run against the same MySQL database used by the deployed LEMS backend.

SET @lems_schema := DATABASE();

SET @lems_sql := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @lems_schema
        AND TABLE_NAME = 'transactions'
        AND COLUMN_NAME = 'checkout_request_id'
    ),
    'SELECT ''transactions.checkout_request_id already exists'' AS migration_status',
    'ALTER TABLE transactions ADD COLUMN checkout_request_id BIGINT UNSIGNED NULL'
  )
);
PREPARE lems_stmt FROM @lems_sql;
EXECUTE lems_stmt;
DEALLOCATE PREPARE lems_stmt;

SET @lems_sql := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @lems_schema
        AND TABLE_NAME = 'checkout_request_items'
        AND COLUMN_NAME = 'quantity'
    ),
    'SELECT ''checkout_request_items.quantity already exists'' AS migration_status',
    'ALTER TABLE checkout_request_items ADD COLUMN quantity INT UNSIGNED NOT NULL DEFAULT 1'
  )
);
PREPARE lems_stmt FROM @lems_sql;
EXECUTE lems_stmt;
DEALLOCATE PREPARE lems_stmt;

SET @lems_sql := (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @lems_schema
        AND TABLE_NAME = 'transactions'
        AND INDEX_NAME = 'idx_transactions_checkout_request_id'
    ),
    'SELECT ''checkout request index already exists'' AS migration_status',
    'CREATE INDEX idx_transactions_checkout_request_id ON transactions (checkout_request_id)'
  )
);
PREPARE lems_stmt FROM @lems_sql;
EXECUTE lems_stmt;
DEALLOCATE PREPARE lems_stmt;
