-- Stage 1: link one RFID card UID to each student account.
-- Apply only after reviewing the schema on a non-production/test database.
-- RFID UIDs are identifiers, not passwords; API access must still require authorization.
CREATE TABLE IF NOT EXISTS student_rfid_cards (
  rfid_card_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  rfid_uid VARCHAR(64) NOT NULL,
  status ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  linked_by INT NULL,
  PRIMARY KEY (rfid_card_id),
  UNIQUE KEY uq_student_rfid_cards_user (user_id),
  UNIQUE KEY uq_student_rfid_cards_uid (rfid_uid),
  KEY idx_student_rfid_cards_status (status),
  CONSTRAINT fk_student_rfid_cards_user
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_student_rfid_cards_linked_by
    FOREIGN KEY (linked_by) REFERENCES users(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;
