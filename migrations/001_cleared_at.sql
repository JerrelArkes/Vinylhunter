-- 2026-09-23: knop "Leegmaken" op de resultatenpagina. Voor databases die al vóór deze
-- kolom zijn aangemaakt (schema.sql bevat hem inmiddels zelf).
ALTER TABLE scans ADD COLUMN cleared_at INTEGER;
