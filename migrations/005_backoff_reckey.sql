-- 2026-09-24: na de winkeltest van 07:57.
-- app_state: o.a. 'discogs_blocked_until' (ms). Na een 429 van Discogs pauzeren alle verwerkers
-- 60 s i.p.v. bij elke poll opnieuw te proberen (dat hield de weigering in stand).
CREATE TABLE IF NOT EXISTS app_state (k TEXT PRIMARY KEY, v INTEGER);
-- rec_key: genormaliseerd "artiest|titel" uit de herkenning, om dubbele foto's al vóór Discogs te
-- herkennen (Bonnie St. Claire 3x in 3 s, Danny de Munk 4x).
ALTER TABLE scans ADD COLUMN rec_key TEXT;
CREATE INDEX IF NOT EXISTS scans_rec_key ON scans(rec_key);
