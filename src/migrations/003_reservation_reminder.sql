-- Tracks the J-1 reminder email so the daily cron never sends it twice.

ALTER TABLE reservations ADD COLUMN reminder_sent_at DATETIME NULL;
