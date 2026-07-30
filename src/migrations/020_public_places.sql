-- Terrains publics (phase 1) : référentiel structuré des équipements sportifs en
-- accès libre, importé depuis Data ES (ministère des Sports, ~330 000 équipements).
--
-- Jusqu'ici `announcements.public_place_id` stockait un simple identifiant texte
-- (equip_numero data.gouv) sans table derrière : impossible d'afficher un nom, une
-- adresse, ni de savoir si le lieu existe réellement. On structure.
--
-- La qualité des données est le point critique : un référentiel national contient des
-- équipements détruits ou fantômes, et une partie organisée sur un terrain inexistant
-- fait perdre l'utilisateur définitivement. D'où `verification_status` et le comptage
-- des confirmations/signalements.

CREATE TABLE IF NOT EXISTS public_places (
  id                  INT NOT NULL AUTO_INCREMENT,
  external_ref        VARCHAR(64)  NOT NULL COMMENT 'equip_numero Data ES',
  name                VARCHAR(200) NOT NULL,
  equip_type          VARCHAR(120) NOT NULL COMMENT 'equip_type_name (liste blanche à l import)',
  sports              JSON         NOT NULL COMMENT 'clés internes, ex ["foot","basket"]',
  address             VARCHAR(255) DEFAULT NULL,
  postal_code         VARCHAR(10)  DEFAULT NULL,
  city                VARCHAR(120) NOT NULL,
  department          VARCHAR(120) DEFAULT NULL,
  lat                 DECIMAL(9,6) NOT NULL,
  lng                 DECIMAL(9,6) NOT NULL,
  free_access         TINYINT(1)   NOT NULL DEFAULT 1,
  lighting            TINYINT(1)   DEFAULT NULL COMMENT 'aire_eclairage : conditionne les parties du soir',
  seasonal            TINYINT(1)   DEFAULT NULL,
  accessible_pmr      TINYINT(1)   DEFAULT NULL,
  source              VARCHAR(20)  NOT NULL DEFAULT 'data_es',
  verification_status VARCHAR(30)  NOT NULL DEFAULT 'auto',
  confirmations_count INT NOT NULL DEFAULT 0,
  reports_count       INT NOT NULL DEFAULT 0,
  last_played_at      DATETIME DEFAULT NULL,
  photo_url           VARCHAR(255) DEFAULT NULL,
  data_updated_at     DATE DEFAULT NULL COMMENT 'equip_maj_date',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_public_places_ref (external_ref),
  KEY idx_public_places_city (city),
  KEY idx_public_places_geo (lat, lng),
  KEY idx_public_places_status (verification_status),
  CONSTRAINT public_places_chk_source CHECK (source IN ('data_es', 'osm', 'user')),
  CONSTRAINT public_places_chk_status CHECK (verification_status IN ('auto', 'osm_confirmed', 'manually_curated', 'community_verified', 'reported_invalid'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS place_reports (
  id         INT NOT NULL AUTO_INCREMENT,
  place_id   INT NOT NULL,
  user_id    INT NOT NULL,
  kind       VARCHAR(30) NOT NULL,
  comment    VARCHAR(500) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_place_report (place_id, user_id),
  KEY idx_place_reports_place (place_id),
  CONSTRAINT fk_place_reports_place FOREIGN KEY (place_id) REFERENCES public_places (id) ON DELETE CASCADE,
  CONSTRAINT fk_place_reports_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT place_reports_chk_kind CHECK (kind IN ('inexistant', 'inaccessible', 'ferme', 'mauvais_etat', 'autre'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Confirmations « j'ai joué ici » : une par utilisateur et par lieu.
CREATE TABLE IF NOT EXISTS place_confirmations (
  id         INT NOT NULL AUTO_INCREMENT,
  place_id   INT NOT NULL,
  user_id    INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_place_confirmation (place_id, user_id),
  CONSTRAINT fk_place_confirmations_place FOREIGN KEY (place_id) REFERENCES public_places (id) ON DELETE CASCADE,
  CONSTRAINT fk_place_confirmations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Rattachement des annonces au référentiel. `public_place_id` (varchar) reste en place
-- pour l'historique mais n'est plus alimenté.
ALTER TABLE announcements ADD COLUMN public_place_ref INT DEFAULT NULL;
ALTER TABLE announcements ADD CONSTRAINT fk_announcements_public_place FOREIGN KEY (public_place_ref) REFERENCES public_places (id) ON DELETE SET NULL;

-- Ville faisant autorité, dénormalisée : tout le ciblage et toutes les métriques
-- (parties par ville, densité) en dépendent. À renseigner depuis public_places.city,
-- jamais depuis une saisie libre.
ALTER TABLE announcements ADD COLUMN city VARCHAR(120) DEFAULT NULL;
ALTER TABLE announcements ADD INDEX idx_announcements_city (city);
