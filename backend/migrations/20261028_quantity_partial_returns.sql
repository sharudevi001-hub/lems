-- LEMS quantity checkout, partial return, and condition tracking.
-- BACK UP lems_db first. Run only after checking existing columns/tables.
-- Existing checkout rows are preserved and receive quantity=1.
ALTER TABLE checkout_request_items
  ADD COLUMN quantity INT UNSIGNED NOT NULL DEFAULT 1 AFTER equipment_id;

-- Student directory fields required by the college registration workflow.
ALTER TABLE users
  ADD COLUMN department VARCHAR(100) NULL,
  ADD COLUMN academic_year VARCHAR(20) NULL,
  ADD COLUMN section VARCHAR(20) NULL,
  ADD COLUMN account_status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE IF NOT EXISTS rfid_registration_sessions (
  registration_session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  target_user_id INT NOT NULL,
  created_by INT NOT NULL,
  status ENUM('PENDING','USED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  used_uid VARCHAR(32) NULL,
  PRIMARY KEY (registration_session_id),
  KEY idx_rfid_registration_pending (status,expires_at),
  CONSTRAINT fk_rfid_registration_target FOREIGN KEY (target_user_id) REFERENCES users(user_id),
  CONSTRAINT fk_rfid_registration_creator FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- Keep every unit-level transaction traceable to the checkout QR request.
ALTER TABLE transactions
  ADD COLUMN checkout_request_id BIGINT UNSIGNED NULL,
  ADD KEY idx_transactions_checkout_request (checkout_request_id),
  ADD CONSTRAINT fk_transactions_checkout_request
    FOREIGN KEY (checkout_request_id) REFERENCES checkout_requests(request_id);

-- Each equipment record receives an opaque QR token. Existing equipment is backfilled.
ALTER TABLE equipment ADD COLUMN qr_token CHAR(32) NULL;
UPDATE equipment SET qr_token = REPLACE(UUID(), '-', '') WHERE qr_token IS NULL OR qr_token = '';
ALTER TABLE equipment ADD UNIQUE KEY uq_equipment_qr_token (qr_token);

CREATE TABLE IF NOT EXISTS return_sessions (
  return_session_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status ENUM('PENDING','CONFIRMED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP NULL,
  confirmed_by INT NULL,
  PRIMARY KEY (return_session_id),
  UNIQUE KEY uq_return_sessions_token_hash (token_hash),
  KEY idx_return_sessions_user_status (user_id,status),
  CONSTRAINT fk_return_sessions_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_return_sessions_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS return_session_items (
  return_session_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  return_session_id BIGINT UNSIGNED NOT NULL,
  transaction_id INT NOT NULL,
  condition_status ENUM('GOOD','DAMAGED','MISSING_PARTS') NULL,
  condition_notes VARCHAR(1000) NULL,
  processed_at TIMESTAMP NULL,
  PRIMARY KEY (return_session_item_id),
  UNIQUE KEY uq_return_session_transaction (return_session_id,transaction_id),
  KEY idx_return_session_items_transaction (transaction_id),
  CONSTRAINT fk_return_session_items_session FOREIGN KEY (return_session_id) REFERENCES return_sessions(return_session_id) ON DELETE CASCADE,
  CONSTRAINT fk_return_session_items_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS equipment_condition_reports (
  condition_report_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_id INT NOT NULL,
  equipment_id INT NOT NULL,
  user_id INT NOT NULL,
  return_session_id BIGINT UNSIGNED NULL,
  condition_status ENUM('GOOD','DAMAGED','MISSING_PARTS') NOT NULL,
  notes VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (condition_report_id),
  KEY idx_condition_equipment_created (equipment_id,created_at),
  CONSTRAINT fk_condition_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
  CONSTRAINT fk_condition_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(equipment_id),
  CONSTRAINT fk_condition_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_condition_return_session FOREIGN KEY (return_session_id) REFERENCES return_sessions(return_session_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lems_audit_logs (
  audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NULL,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100) NULL,
  details JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (audit_id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_entity (entity_type,entity_id),
  CONSTRAINT fk_lems_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;
