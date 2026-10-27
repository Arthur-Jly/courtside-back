-- Niveau déclaré par le joueur, sport par sport (page « Bienvenue », profil) :
-- on peut être confirmé au foot et débutant au padel. Déclaratif uniquement ;
-- une correction par les pairs pourra s'y ajouter plus tard.
-- Codes : debutant | intermediaire | confirme | competition.
CREATE TABLE IF NOT EXISTS user_sport_levels (
  user_id INT NOT NULL,
  sport VARCHAR(20) NOT NULL,
  level VARCHAR(20) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, sport),
  CONSTRAINT fk_user_sport_levels_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
