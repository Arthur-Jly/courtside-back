-- last_minute_slots was a hand-filled demo table (fictional venues shown to
-- real users on /annonces, no insert path in the product). The /lastminute
-- API now serves the real free slots of today/tomorrow from `slots`.

DROP TABLE IF EXISTS last_minute_slots;
