-- 2026-09-24: herkenning met Sonnet 5, bij "niet gevonden" nog één poging met Opus 5 (FALLBACK_MODEL).
-- model: welk Claude-model de huidige herkenning leverde. De foto blijft bewaard tot de Discogs-uitkomst
-- bekend is, zodat Opus hem nog kan lezen; daarna wordt hij gewist zoals voorheen.
ALTER TABLE scans ADD COLUMN model TEXT;
