-- clubs.api_url / clubs.api_key: zero references in back or front code
-- (legacy idea of per-club external APIs). api_key was also a plaintext
-- secret sitting in the database — gone before production.

ALTER TABLE clubs DROP COLUMN api_url;

ALTER TABLE clubs DROP COLUMN api_key;
