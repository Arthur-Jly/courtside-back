-- Production hardening: value constraints, collation harmonization,
-- data resync and one-time purge of dead rows.

-- 'client' and 'player' both meant "regular user" (legacy naming split);
-- code only ever branches on 'club_admin'. Normalize, then lock values.
UPDATE users SET role = 'player' WHERE role = 'client';

ALTER TABLE users ADD CONSTRAINT users_chk_role CHECK (role IN ('player', 'club_admin'));

-- slots.status became a VARCHAR in 009 — constrain its values.
ALTER TABLE slots ADD CONSTRAINT slots_chk_status CHECK (status IN ('free', 'booked', 'blocked'));

-- Last 2 tables on utf8mb4_unicode_ci; everything else is utf8mb4_0900_ai_ci.
-- Mixed collations break/slow JOINs on text columns.
ALTER TABLE club_socials CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE terrain_images CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- amis: unique_amis only blocks exact duplicates — (A,B) then (B,A) was
-- still possible. Functional index blocks the reversed pair too.
ALTER TABLE amis ADD UNIQUE INDEX uq_amis_pair ((LEAST(user_id_1, user_id_2)), (GREATEST(user_id_1, user_id_2)));

-- Resync places_disponibles: cancelling a session deletes its participants
-- but kept the stale counter (5 rows drifted).
UPDATE announcements a
  LEFT JOIN (SELECT annonce_id, COUNT(*) n FROM annonce_participants GROUP BY annonce_id) p
    ON p.annonce_id = a.id
  SET a.places_disponibles = a.places_total - COALESCE(p.n, 0);

-- One-time purge: 99% of slots were past 'free' rows nobody can book.
-- Recurring cleanup lives in cronService (db-cleanup job).
DELETE FROM slots WHERE status = 'free' AND date < CURDATE();
