-- 2026-09-25: meerdere standen in de app (vinyl, pokemon, keramiek, zilver).
-- kind: soort scan; alle bestaande rijen zijn vinyl.
-- details: JSON met de uitkomst per soort (Pokémon-kaart en TCGdex-treffer, analyse en prijscheck
--   van keramiek/zilver). Vinyl gebruikt de vaste kolommen.
-- scan_images: extra foto's van één stuk (keramiek: bodem/stempel, zilver: keurtekens). De eerste foto
--   staat in scans.image. Blijven 30 dagen bewaard om de analyses te kunnen nakijken.
ALTER TABLE scans ADD COLUMN kind TEXT NOT NULL DEFAULT 'vinyl';
ALTER TABLE scans ADD COLUMN details TEXT;
CREATE INDEX IF NOT EXISTS scans_kind ON scans(kind);
CREATE TABLE IF NOT EXISTS scan_images (
  scan_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,                  -- 1, 2, 3 (0 is scans.image)
  data TEXT NOT NULL,                    -- base64 JPEG
  PRIMARY KEY (scan_id, idx)
);
