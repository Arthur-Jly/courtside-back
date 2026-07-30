-- Espace admin plateforme (super-admin) + flow d'invitation gérant de club.
--
-- 1. Rôle `admin` ajouté au CHECK de users.role (super-admin plateforme,
--    distinct de player/club_admin).
-- 2. Statut `rejete` ajouté au CHECK de clubs.status (attente -> confirme|rejete),
--    + colonnes d'audit de la décision (qui/quand/pourquoi).
-- 3. Table club_invitations : jeton d'invitation envoyé au gérant quand un club
--    est confirmé. Le gérant crée son compte via ce lien et est relié au club.
--    Même forme que password_resets (token hashé, expiration, used_at).

ALTER TABLE users DROP CHECK users_chk_role;
ALTER TABLE users ADD CONSTRAINT users_chk_role CHECK (role IN ('player', 'club_admin', 'admin'));

ALTER TABLE clubs DROP CHECK clubs_chk_1;
ALTER TABLE clubs ADD CONSTRAINT clubs_chk_1 CHECK (status IN ('attente', 'confirme', 'rejete'));

ALTER TABLE clubs ADD COLUMN reviewed_by INT DEFAULT NULL;
ALTER TABLE clubs ADD COLUMN reviewed_at DATETIME DEFAULT NULL;
ALTER TABLE clubs ADD COLUMN reject_reason VARCHAR(500) DEFAULT NULL;

CREATE TABLE IF NOT EXISTS club_invitations (
  id INT NOT NULL AUTO_INCREMENT,
  club_id INT NOT NULL,
  email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_club_invitations_token (token_hash),
  KEY idx_club_invitations_club (club_id),
  CONSTRAINT fk_club_invitations_club FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
