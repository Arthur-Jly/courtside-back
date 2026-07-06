-- Post-match fair-play ratings between participants of a session.
-- One rating per (session, rater, rated) triple; 1-5 scale.

CREATE TABLE IF NOT EXISTS player_ratings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  annonce_id INT NOT NULL,
  rater_id INT NOT NULL,
  rated_user_id INT NOT NULL,
  rating TINYINT NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uq_player_rating (annonce_id, rater_id, rated_user_id),
  INDEX idx_player_ratings_rated (rated_user_id)
);
