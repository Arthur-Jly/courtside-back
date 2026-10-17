-- Vérification automatique des terrains publics : on stocke les PREUVES
-- d'existence, le statut en découle (services/placeStatus.deriveStatus).
--
-- Constat (oct. 2026) : Data ES contient des terrains disparus que rien dans la
-- fiche ne permet de repérer. Deux sources indépendantes servent de recoupement :
--   - BD TOPO de l'IGN (terrains repérés sur photos aériennes, « En service »,
--     date de confirmation) → statut `ign_confirmed` ;
--   - OpenStreetMap (terrain `leisure=pitch` du bon sport, accès non privé)
--     → statut `osm_confirmed`.
-- Un terrain sans aucune preuve reste `auto` et n'est plus montré par défaut.

ALTER TABLE public_places DROP CHECK public_places_chk_status;
ALTER TABLE public_places ADD CONSTRAINT public_places_chk_status CHECK (verification_status IN ('auto', 'ign_confirmed', 'osm_confirmed', 'manually_curated', 'community_verified', 'reported_invalid'));

-- BD TOPO : identifiant (cleabs), nature (« Petit terrain multi-sports »…),
-- date de confirmation IGN, et date de notre dernière vérification.
ALTER TABLE public_places ADD COLUMN ign_ref VARCHAR(40) DEFAULT NULL;
ALTER TABLE public_places ADD COLUMN ign_nature VARCHAR(120) DEFAULT NULL;
ALTER TABLE public_places ADD COLUMN ign_confirmed_at DATE DEFAULT NULL;
ALTER TABLE public_places ADD COLUMN ign_checked_at DATETIME DEFAULT NULL;

-- OSM : élément apparié (« way/123 »), terrain désaffecté repéré au même endroit
-- (signal négatif), date de notre dernière vérification.
ALTER TABLE public_places ADD COLUMN osm_ref VARCHAR(30) DEFAULT NULL;
ALTER TABLE public_places ADD COLUMN osm_disused TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE public_places ADD COLUMN osm_checked_at DATETIME DEFAULT NULL;

-- Coordonnées Data ES d'origine quand le point a été recalé sur le terrain IGN
-- (Data ES place parfois le point à l'adresse, à plusieurs dizaines de mètres).
ALTER TABLE public_places ADD COLUMN original_lat DECIMAL(9,6) DEFAULT NULL;
ALTER TABLE public_places ADD COLUMN original_lng DECIMAL(9,6) DEFAULT NULL;

-- Terrain qui ne ressort plus de Data ES au rafraîchissement de sa zone : masqué,
-- jamais supprimé (des parties et des signalements s'y rattachent).
ALTER TABLE public_places ADD COLUMN source_missing_at DATETIME DEFAULT NULL;
