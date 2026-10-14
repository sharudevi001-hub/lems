-- LEMS checkout QR workflow schema (apply manually after review).
-- One checkout request may contain multiple distinct equipment records.
-- Only a SHA-256 token hash is stored; the raw random token is shown to the student once.
CREATE TABLE IF NOT EXISTS checkout_requests (
  request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status ENUM('PENDING','ISSUED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_at TIMESTAMP NULL DEFAULT NULL,
  issued_by INT NULL,
  PRIMARY KEY (request_id),
  UNIQUE KEY uq_checkout_requests_token_hash (token_hash),
  KEY idx_checkout_requests_user_status (user_id, status),
  CONSTRAINT fk_checkout_requests_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_checkout_requests_issuer FOREIGN KEY (issued_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS checkout_request_items (
  request_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id BIGINT UNSIGNED NOT NULL,
  equipment_id INT NOT NULL,
  PRIMARY KEY (request_item_id),
  UNIQUE KEY uq_checkout_request_equipment (request_id, equipment_id),
  KEY idx_checkout_request_items_equipment (equipment_id),
  CONSTRAINT fk_checkout_request_items_request FOREIGN KEY (request_id) REFERENCES checkout_requests(request_id) ON DELETE CASCADE,
  CONSTRAINT fk_checkout_request_items_equipment FOREIGN KEY (equipment_id) REFERENCES equipment(equipment_id)
) ENGINE=InnoDB;

-- One-time return QR tokens are separate from checkout tokens.
CREATE TABLE IF NOT EXISTS return_qr_tokens (
  return_token_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  status ENUM('PENDING','USED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP NULL DEFAULT NULL,
  used_by INT NULL,
  PRIMARY KEY (return_token_id),
  UNIQUE KEY uq_return_qr_token_hash (token_hash),
  KEY idx_return_qr_transaction_status (transaction_id, status),
  CONSTRAINT fk_return_qr_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
  CONSTRAINT fk_return_qr_used_by FOREIGN KEY (used_by) REFERENCES users(user_id)
) ENGINE=InnoDB;
