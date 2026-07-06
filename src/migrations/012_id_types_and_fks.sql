-- Harmonize referencing column types with their parent PKs, then add the
-- missing foreign keys. Parent PK types stay untouched (users/clubs = INT,
-- terrains/chats/announcements/reservations/slots = BIGINT UNSIGNED);
-- children are aligned to them.
--
-- ON DELETE policy:
--   CASCADE  — pure child/junction rows, meaningless without the parent
--   SET NULL — history-bearing rows that must survive the parent (nullable col)
-- Note: account deletion is an anonymization (users row is never deleted),
-- so user FKs are belt-and-braces, not a behavior change.

-- ── Data fixes (orphans found before FK creation) ──────────────────────────
UPDATE events SET terrain_id = NULL
  WHERE terrain_id IS NOT NULL AND terrain_id NOT IN (SELECT id FROM terrains);
DELETE FROM favorites
  WHERE terrain_id IS NOT NULL AND terrain_id NOT IN (SELECT id FROM terrains);

-- ── Type alignment ─────────────────────────────────────────────────────────
ALTER TABLE annonce_invitations MODIFY annonce_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE annonce_participants MODIFY annonce_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE annonce_waitlist MODIFY annonce_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE player_ratings MODIFY annonce_id BIGINT UNSIGNED NOT NULL;
ALTER TABLE chats MODIFY announcement_id BIGINT UNSIGNED DEFAULT NULL;

ALTER TABLE messages MODIFY chat_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE payments MODIFY reservation_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE reservation_share_payments MODIFY reservation_id BIGINT UNSIGNED NOT NULL;

ALTER TABLE announcements MODIFY terrain_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE events MODIFY terrain_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE favorites MODIFY terrain_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE reservations MODIFY terrain_id BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE clubs_stats MODIFY popular_terrain_id BIGINT UNSIGNED DEFAULT NULL;

ALTER TABLE reservation_participants MODIFY user_id INT DEFAULT NULL;
ALTER TABLE amis MODIFY user_id_1 INT NOT NULL;
ALTER TABLE amis MODIFY user_id_2 INT NOT NULL;

-- ── Foreign keys ───────────────────────────────────────────────────────────
ALTER TABLE amis
  ADD CONSTRAINT fk_amis_user1 FOREIGN KEY (user_id_1) REFERENCES users (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_amis_user2 FOREIGN KEY (user_id_2) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE annonce_invitations
  ADD CONSTRAINT fk_annonce_invitations_annonce FOREIGN KEY (annonce_id) REFERENCES announcements (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_annonce_invitations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_annonce_invitations_inviter FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE annonce_participants
  ADD CONSTRAINT fk_annonce_participants_annonce FOREIGN KEY (annonce_id) REFERENCES announcements (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_annonce_participants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE annonce_waitlist
  ADD CONSTRAINT fk_annonce_waitlist_annonce FOREIGN KEY (annonce_id) REFERENCES announcements (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_annonce_waitlist_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE announcements
  ADD CONSTRAINT fk_announcements_terrain FOREIGN KEY (terrain_id) REFERENCES terrains (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_announcements_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE chats
  ADD CONSTRAINT fk_chats_announcement FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE SET NULL;

ALTER TABLE clubs_stats
  ADD CONSTRAINT fk_clubs_stats_club FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_clubs_stats_terrain FOREIGN KEY (popular_terrain_id) REFERENCES terrains (id) ON DELETE SET NULL;

ALTER TABLE events
  ADD CONSTRAINT fk_events_club FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_events_terrain FOREIGN KEY (terrain_id) REFERENCES terrains (id) ON DELETE SET NULL;

ALTER TABLE favorites
  ADD CONSTRAINT fk_favorites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_favorites_terrain FOREIGN KEY (terrain_id) REFERENCES terrains (id) ON DELETE CASCADE;

ALTER TABLE messages
  ADD CONSTRAINT fk_messages_chat FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE notifications
  ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE password_resets
  ADD CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE payments
  ADD CONSTRAINT fk_payments_reservation FOREIGN KEY (reservation_id) REFERENCES reservations (id) ON DELETE SET NULL;

ALTER TABLE player_ratings
  ADD CONSTRAINT fk_player_ratings_annonce FOREIGN KEY (annonce_id) REFERENCES announcements (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_player_ratings_rater FOREIGN KEY (rater_id) REFERENCES users (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_player_ratings_rated FOREIGN KEY (rated_user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE reservation_participants
  ADD CONSTRAINT fk_reservation_participants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE reservation_share_payments
  ADD CONSTRAINT fk_share_payments_reservation FOREIGN KEY (reservation_id) REFERENCES reservations (id) ON DELETE CASCADE;

ALTER TABLE reservations
  ADD CONSTRAINT fk_reservations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_reservations_terrain FOREIGN KEY (terrain_id) REFERENCES terrains (id) ON DELETE SET NULL;

ALTER TABLE reviews
  ADD CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_reviews_club FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE;

ALTER TABLE terrains
  ADD CONSTRAINT fk_terrains_club FOREIGN KEY (club_id) REFERENCES clubs (id) ON DELETE CASCADE;

ALTER TABLE user_profiles
  ADD CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
