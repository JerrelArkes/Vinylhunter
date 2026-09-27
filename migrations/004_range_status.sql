-- 2026-09-24: prijs in twee stappen. Stap 1 zet ondergrens + aantal te koop, stap 2 vult de
-- bovenkant aan zodra er geen nieuwe scans wachten.
-- range_status: NULL = compleet (of n.v.t.), 'pending' = bovenkant nog op te halen, 'filling' = bezig.
ALTER TABLE scans ADD COLUMN range_status TEXT;
ALTER TABLE scans ADD COLUMN range_at INTEGER;
CREATE INDEX IF NOT EXISTS scans_range ON scans(range_status);
