-- LEMS partial-return workflow
-- Apply this migration to the same MySQL database used by the backend before using the new API.
CREATE TABLE IF NOT EXISTS return_batches (
    return_batch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    barcode VARCHAR(32) NOT NULL,
    user_id INT NOT NULL,
    status ENUM('PENDING', 'CONFIRMED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME NULL,
    confirmed_by INT NULL,
    PRIMARY KEY (return_batch_id),
    UNIQUE KEY uq_return_batches_barcode (barcode),
    KEY idx_return_batches_user_status (user_id, status),
    KEY idx_return_batches_status_created (status, created_at),
    CONSTRAINT fk_return_batches_user FOREIGN KEY (user_id) REFERENCES users(user_id),
    CONSTRAINT fk_return_batches_confirmer FOREIGN KEY (confirmed_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS return_batch_items (
    return_batch_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    return_batch_id BIGINT UNSIGNED NOT NULL,
    transaction_id INT NOT NULL,
    PRIMARY KEY (return_batch_item_id),
    UNIQUE KEY uq_return_batch_transaction (return_batch_id, transaction_id),
    KEY idx_return_batch_items_transaction (transaction_id),
    CONSTRAINT fk_return_batch_items_batch FOREIGN KEY (return_batch_id) REFERENCES return_batches(return_batch_id) ON DELETE CASCADE,
    CONSTRAINT fk_return_batch_items_transaction FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
) ENGINE=InnoDB;
