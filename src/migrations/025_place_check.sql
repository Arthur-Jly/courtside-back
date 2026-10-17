-- Après une partie sur un terrain public, on demande aux participants si le
-- terrain existait bien (services/placeCommunity, tâche cron horaire). Cette
-- colonne garantit qu'on ne pose la question qu'une fois par partie.
ALTER TABLE announcements ADD COLUMN place_check_sent_at DATETIME DEFAULT NULL;
