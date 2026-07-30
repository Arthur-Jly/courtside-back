-- Journal d'événements produit (phase 1).
--
-- Le go/no-go de la phase 1 se joue sur trois chiffres mesurés PAR VILLE ET PAR
-- SPORT : parties publiées par semaine, taux de remplissage, rétention S+1. Une
-- moyenne nationale masque le vide local, et sans instrumentation dès le jour 1
-- la décision à 6 semaines est intranchable.
--
-- La table s'appelle `analytics_events` et non `events` : `events` existe déjà
-- (événements organisés par les clubs).
--
-- Les colonnes `city` et `sport` sont dénormalisées à l'écriture : une annonce
-- supprimée ne doit pas effacer le fait qu'elle a été publiée.

CREATE TABLE IF NOT EXISTS analytics_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type            VARCHAR(40) NOT NULL COMMENT 'game_published, game_joined, game_left, game_filled, game_cancelled, game_expired, place_confirmed, place_reported',
  user_id         INT DEFAULT NULL,
  announcement_id BIGINT UNSIGNED DEFAULT NULL,
  place_id        INT DEFAULT NULL,
  city            VARCHAR(120) DEFAULT NULL COMMENT 'dénormalisé : la granularité de la densité',
  sport           VARCHAR(30)  DEFAULT NULL,
  payload         JSON DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_analytics_type_date (type, created_at),
  KEY idx_analytics_city_sport (city, sport, created_at),
  KEY idx_analytics_user (user_id, created_at),
  KEY idx_analytics_announcement (announcement_id),
  CONSTRAINT fk_analytics_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_analytics_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE SET NULL,
  CONSTRAINT fk_analytics_place FOREIGN KEY (place_id) REFERENCES public_places (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
