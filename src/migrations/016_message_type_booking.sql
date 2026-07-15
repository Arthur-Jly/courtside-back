-- routes/chats.js inserts message_type = 'booking_request' (booking proposal
-- from a conversation) but the ENUM never included it — the INSERT fails in
-- strict mode and the feature silently 500s. Surfaced by test BK-CHAT-04b.

ALTER TABLE messages MODIFY message_type ENUM('text','invitation','system','booking_request') DEFAULT 'text';
