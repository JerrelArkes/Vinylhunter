-- 2026-09-25: dubbele foto's vóór de herkenning overslaan (scheelt Claude-aanroepen).
-- feat: kenmerken van de foto uit de camera (grijsafdruk 32x24 + kleurhistogram), JSON.
-- taken_at: moment van de foto volgens de telefoon (uploads kunnen later binnenkomen).
-- twin: 1 = overgeslagen als tweede foto van dezelfde hoes (duplicate_of wijst naar het origineel).
ALTER TABLE scans ADD COLUMN feat TEXT;
ALTER TABLE scans ADD COLUMN taken_at INTEGER;
ALTER TABLE scans ADD COLUMN twin INTEGER;
