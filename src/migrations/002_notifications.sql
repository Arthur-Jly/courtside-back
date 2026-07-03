CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type VARCHAR(40) NOT NULL,
  payload JSON NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_notifications_user (user_id, read_at),
  INDEX idx_notifications_created (created_at)
);
