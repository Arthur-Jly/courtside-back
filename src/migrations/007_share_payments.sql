-- Individual share payments for split reservations. Each row is one
-- teammate's paid share, keyed by its own Stripe Checkout session.

CREATE TABLE IF NOT EXISTS reservation_share_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reservation_id INT NOT NULL,
  stripe_session_id VARCHAR(120) NOT NULL,
  amount DECIMAL(8,2) NOT NULL,
  payer_email VARCHAR(254) NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_share_session (stripe_session_id),
  INDEX idx_share_reservation (reservation_id)
);
