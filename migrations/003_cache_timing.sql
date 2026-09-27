-- 2026-09-24: Discogs-cache (dezelfde plaat of een dubbele foto kost 0 calls) en tijdstempels
-- om de doorlooptijd te meten (herkend na X s, prijs na Y s).
CREATE TABLE IF NOT EXISTS discogs_cache (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
ALTER TABLE scans ADD COLUMN recognized_at INTEGER;
ALTER TABLE scans ADD COLUMN done_at INTEGER;
ALTER TABLE scans ADD COLUMN discogs_calls INTEGER;
