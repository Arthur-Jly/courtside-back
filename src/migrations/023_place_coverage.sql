-- Couverture des terrains publics : quelles zones ont déjà été interrogées sur
-- Data ES (ministère des Sports).
--
-- Le référentiel est rempli à la demande : une recherche sur une zone jamais vue
-- interroge l'API, filtre, et enregistre les terrains en base (voir
-- services/placeCoverage.js). Cette table évite de re-solliciter l'API à chaque
-- recherche, y compris dans une zone qui n'a vraiment aucun terrain.
--
-- Une cellule = 0,1° de latitude / longitude (~11 km) : cell = FLOOR(coord * 10).

CREATE TABLE IF NOT EXISTS place_coverage (
  cell_lat     SMALLINT NOT NULL,
  cell_lng     SMALLINT NOT NULL,
  places_found INT      NOT NULL DEFAULT 0,
  fetched_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cell_lat, cell_lng)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
