-- Waitlist for full sessions. First-come first-served; notified_at marks
-- users already pinged about a freed spot so they are not spammed.

CREATE TABLE IF NOT EXISTS annonce_waitlist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  annonce_id INT NOT NULL,
  user_id INT NOT NULL,
  notified_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_waitlist_entry (annonce_id, user_id),
  INDEX idx_waitlist_annonce (annonce_id, created_at)
);
