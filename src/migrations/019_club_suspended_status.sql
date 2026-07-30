-- Statut `suspendu` pour les clubs : permet de retirer temporairement un club
-- confirmé de la plateforme (litige, fraude, demande du club) sans le rejeter.
--
-- Toutes les requêtes publiques filtrent déjà `c.status = 'confirme'`, donc un
-- club suspendu disparaît automatiquement des listings, de la recherche, des
-- créneaux last-minute et des annonces — sans autre changement de code.

ALTER TABLE clubs DROP CHECK clubs_chk_1;
ALTER TABLE clubs ADD CONSTRAINT clubs_chk_1 CHECK (status IN ('attente', 'confirme', 'rejete', 'suspendu'));
