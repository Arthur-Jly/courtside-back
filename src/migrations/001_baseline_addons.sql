-- Baseline additions previously applied ad hoc at server boot.
-- The runner ignores "already exists" errors (1050/1060/1061) so this file
-- is safe on databases where the old boot-time ALTERs already ran.

ALTER TABLE announcements ADD COLUMN lat DECIMAL(10,8) NULL;

ALTER TABLE announcements ADD COLUMN lng DECIMAL(11,8) NULL;

ALTER TABLE reservations ADD COLUMN stripe_session_id VARCHAR(120) NULL;

ALTER TABLE reservations ADD UNIQUE INDEX uq_reservations_stripe_session (stripe_session_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_password_resets_token (token_hash),
  INDEX idx_password_resets_user (user_id)
);
