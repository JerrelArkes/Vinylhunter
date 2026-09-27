// Zilverprijs in euro per gram puur zilver, voor de smeltwaarde in de stand Zilver.
// Bron: gold-api.com (gratis, geen sleutel; gekozen 2026-09-25). Eén uur in de D1-cache; lukt ophalen
// niet, dan de laatst bekende prijs tot 7 dagen oud, anders null (de analyse zegt dan dat hij onbekend is).
const TROY_OZ_G = 31.1034768;
const KEY = 'metal:XAG-EUR';

export async function silverPerGram(env) {
  const row = await env.DB.prepare('SELECT body, fetched_at FROM discogs_cache WHERE path = ?').bind(KEY).first();
  const age = row ? Date.now() - row.fetched_at : Infinity;
  if (age < 3600_000) return JSON.parse(row.body).perGram;
  try {
    const r = await fetch('https://api.gold-api.com/price/XAG/EUR', { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if (j.currency !== 'EUR' || !(j.price > 0)) throw new Error('onverwacht antwoord');
    const perGram = j.price / TROY_OZ_G;
    await env.DB.prepare('INSERT OR REPLACE INTO discogs_cache (path, body, fetched_at) VALUES (?, ?, ?)')
      .bind(KEY, JSON.stringify({ perGram, updatedAt: j.updatedAt }), Date.now()).run();
    return perGram;
  } catch {
    return age < 7 * 86400_000 ? JSON.parse(row.body).perGram : null;
  }
}
