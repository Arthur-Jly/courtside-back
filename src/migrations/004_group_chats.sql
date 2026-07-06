-- Links a group chat to the announcement it was created for,
-- so "match conversation" creation stays idempotent (one group per session).

ALTER TABLE chats ADD COLUMN announcement_id INT NULL;

ALTER TABLE chats ADD UNIQUE INDEX uq_chats_announcement (announcement_id);
