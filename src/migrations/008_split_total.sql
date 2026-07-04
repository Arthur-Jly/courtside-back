-- Number of shares a split reservation is divided into (NULL / 1 = not split).
-- Lets the profile show "X/Y parts payées" for shared bookings.

ALTER TABLE reservations ADD COLUMN split_total TINYINT NULL;
