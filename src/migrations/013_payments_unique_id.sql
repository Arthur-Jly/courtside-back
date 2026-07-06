-- Missed in 011: payments also carried the redundant UNIQUE KEY `id`
-- duplicating the PRIMARY KEY.

ALTER TABLE payments DROP INDEX id;
