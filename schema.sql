-- Toepassen: npx.cmd wrangler d1 execute <database> --remote --file schema.sql  (lokaal: --local; <database> = database_name in wrangler.jsonc)
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,           -- ms sinds epoch
  source TEXT,                           -- 'auto' | 'knop' | 'test' | later 'bril'
  -- queued -> recognizing -> recognized -> looking_up -> done (vinyl, Pokémon)
  -- uploading -> queued -> recognizing -> done (keramiek/zilver; daarna eventueel range_status = prijscheck)
  -- eindstatussen: done | unclear | no_record | not_found | error
  status TEXT NOT NULL,
  claimed_at INTEGER,                    -- wanneer een verwerker hem pakte (voor vastgelopen rijen)
  attempts INTEGER NOT NULL DEFAULT 0,   -- mislukte pogingen; na 3 -> error
  image TEXT,                            -- base64 JPEG; vinyl/Pokémon: gewist zodra de uitkomst vastligt, keramiek/zilver: 30 dagen
  thumb TEXT,                            -- base64 JPEG ~240px, blijft
  artist TEXT, title TEXT, other_side TEXT, catno TEXT, label TEXT, format TEXT,
  discogs_key TEXT, discogs_url TEXT, discogs_title TEXT, discogs_step TEXT,
  pressings INTEGER, price_low REAL, price_high REAL, for_sale INTEGER,
  duplicate_of INTEGER,
  error TEXT,
  cleared_at INTEGER,                    -- gezet door "Leegmaken": verborgen, niet gewist
  recognized_at INTEGER, done_at INTEGER, discogs_calls INTEGER,   -- timing (migratie 003)
  range_status TEXT,                     -- NULL compleet | 'pending' | 'filling' | 'error' (migratie 004)
  range_at INTEGER,
  rec_key TEXT,                          -- "artiest|titel" om dubbele foto's vóór Discogs te herkennen (migratie 005)
  model TEXT,                            -- Claude-model van de huidige herkenning (migratie 006)
  feat TEXT,                             -- kenmerken uit de camera (grijsafdruk + kleurhistogram), JSON (migratie 007)
  taken_at INTEGER,                      -- moment van de foto volgens de telefoon (migratie 007)
  twin INTEGER,                          -- 1 = overgeslagen als tweede foto van dezelfde hoes (migratie 007)
  kind TEXT NOT NULL DEFAULT 'vinyl',    -- 'vinyl' | 'pokemon' | 'keramiek' | 'zilver' (migratie 008)
  details TEXT                           -- JSON-uitkomst per soort (migratie 008)
);
CREATE INDEX IF NOT EXISTS scans_range ON scans(range_status);
CREATE INDEX IF NOT EXISTS scans_rec_key ON scans(rec_key);
CREATE INDEX IF NOT EXISTS scans_kind ON scans(kind);

-- Extra foto's van één stuk (keramiek/zilver); de eerste staat in scans.image. Migratie 008.
CREATE TABLE IF NOT EXISTS scan_images (
  scan_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (scan_id, idx)
);

-- Losse waarden: 'discogs_blocked_until' (pauze na 429), 'agent_seen' (heartbeat agent). Migratie 005.
CREATE TABLE IF NOT EXISTS app_state (k TEXT PRIMARY KEY, v INTEGER);

CREATE TABLE IF NOT EXISTS discogs_cache (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scans_status ON scans(status);
CREATE INDEX IF NOT EXISTS scans_created ON scans(created_at);
CREATE INDEX IF NOT EXISTS scans_key ON scans(discogs_key);

-- Wachtwoordlogin: max 3 fout per IP, daarna 1 uur blokkade (src/auth.js).
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  locked_until INTEGER,
  last_at INTEGER NOT NULL
);

-- Eén rij per Discogs-call, voor de 60/min-limiet (ouder dan 2 minuten wordt opgeruimd).
CREATE TABLE IF NOT EXISTS discogs_calls (ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS discogs_calls_ts ON discogs_calls(ts);
