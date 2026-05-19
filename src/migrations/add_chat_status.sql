-- Add status column to chats table for DM request system
ALTER TABLE chats ADD COLUMN status ENUM('accepted', 'pending', 'rejected') NOT NULL DEFAULT 'accepted' AFTER type;
