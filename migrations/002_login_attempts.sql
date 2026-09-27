-- 2026-09-23: tijdelijk wachtwoord voor het testpanel, max 3 pogingen per IP, daarna 1 uur blokkade.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  locked_until INTEGER,
  last_at INTEGER NOT NULL
);
