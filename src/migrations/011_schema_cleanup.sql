-- Schema cleanup before production deploy.
-- 1) announcements: the old CHECK predates the 'validated' status and makes
--    every validation UPDATE fail — the ENUM alone is the source of truth.
-- 2) messages: conversations were loaded with a full-table scan (no index on chat_id).
-- 3) Redundant UNIQUE KEY `id` duplicating the PRIMARY KEY on legacy tables.
-- 4) amis: unique_friendship duplicated unique_amis (same columns).
-- 5) announcements: duplicated FKs (ibfk_* + fk_*) on slot_id / reservation_id.
-- 6) clubs_stats: one stats row per club.
-- 7) last_minute_slots: camelCase columns -> snake_case (API shape preserved
--    via aliases in lastminute.controller.js).

ALTER TABLE announcements DROP CHECK announcements_chk_1;

ALTER TABLE messages ADD INDEX idx_messages_chat_created (chat_id, created_at);

ALTER TABLE amis DROP INDEX id;
ALTER TABLE annonce_invitations DROP INDEX id;
ALTER TABLE annonce_participants DROP INDEX id;
ALTER TABLE announcements DROP INDEX id;
ALTER TABLE clubs_stats DROP INDEX id;
ALTER TABLE events DROP INDEX id;
ALTER TABLE favorites DROP INDEX id;
ALTER TABLE messages DROP INDEX id;
ALTER TABLE reservations DROP INDEX id;
ALTER TABLE reviews DROP INDEX id;
ALTER TABLE terrains DROP INDEX id;

ALTER TABLE amis DROP INDEX unique_friendship;

ALTER TABLE announcements DROP FOREIGN KEY announcements_ibfk_1;
ALTER TABLE announcements DROP FOREIGN KEY announcements_ibfk_2;

ALTER TABLE clubs_stats ADD UNIQUE INDEX uq_clubs_stats_club (club_id);

ALTER TABLE last_minute_slots RENAME COLUMN currentPlayers TO current_players;
ALTER TABLE last_minute_slots RENAME COLUMN maxPlayers TO max_players;
