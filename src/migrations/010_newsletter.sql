-- Newsletter opt-in list (footer subscribe form). Email unique.

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_newsletter_email (email)
);
