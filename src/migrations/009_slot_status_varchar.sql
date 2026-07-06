-- Widen slots.status so it can hold 'blocked' (manual club blocking) in
-- addition to 'free'/'booked'. Safe whether it was ENUM or already VARCHAR.

ALTER TABLE slots MODIFY COLUMN status VARCHAR(20) NOT NULL DEFAULT 'free';
