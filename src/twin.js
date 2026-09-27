// Tweede foto van dezelfde hoes herkennen vóór de (betaalde) herkenning.
// De gretige camera maakt ~2,5 foto's per plaat. Gemeten op 63 paren van 2026-09-24 (kenmerken uit de
// thumbs): kleurhistogram-overlap >= 0,85 én grijsafdruk-verschil (met verschuiving) <= 16 ving 15 van
// 22 dubbele paren en geen enkele van 38 wissels naar een andere hoes (dichtstbij: 18,7 / 0,81).
export const TWIN_WINDOW_MS = 1500, TWIN_HIST = 0.85, TWIN_SHIFT = 16;

// a, b: { s: 768 getallen (32x24 grijs, gemiddelde eraf), h: 108 getallen (kleurhistogram, som 1) }
export function sameSleeve(a, b) {
  let inter = 0;
  for (let i = 0; i < 108; i++) inter += Math.min(a.h[i], b.h[i]);
  if (inter < TWIN_HIST) return false;
  return shiftDiff(a.s, b.s) <= TWIN_SHIFT;
}

// Kleinste gemiddelde verschil over verschuivingen van max. 4 blokjes: dezelfde hoes iets anders in beeld.
export function shiftDiff(a, b) {
  let best = Infinity;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    let s = 0, n = 0;
    for (let y = Math.max(0, dy); y < Math.min(24, 24 + dy); y++)
      for (let x = Math.max(0, dx); x < Math.min(32, 32 + dx); x++) { s += Math.abs(a[y * 32 + x] - b[(y - dy) * 32 + (x - dx)]); n++; }
    if (n > 300) best = Math.min(best, s / n);
  }
  return best;
}

// Zelfde berekening als features() + grab() in src/pages/cam.html, voor RGBA- of RGB-pixels van een
// 320x240-beeld. Voor tools/dubbeltest.mjs; wijzig je de ene, wijzig dan ook de andere.
export function featuresFromPixels(d, channels = 4) {
  const s = new Array(768).fill(0);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * channels;
    s[((y / 10) | 0) * 32 + ((x / 10) | 0)] += (d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11) / 100;
  }
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  const h = new Array(108).fill(0);
  let n = 0;
  for (let y = 2; y < 240; y += 5) for (let x = 2; x < 320; x += 5) {
    const i = (y * 320 + x) * channels, r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const mx = Math.max(r, g, b), dd = mx - Math.min(r, g, b);
    let hue = 0;
    if (dd) hue = mx === r ? ((g - b) / dd + 6) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
    const sat = mx ? dd / mx : 0;
    h[Math.min(11, (hue * 2) | 0) * 9 + Math.min(2, (sat * 3) | 0) * 3 + Math.min(2, (mx * 3) | 0)]++;
    n++;
  }
  return { s: s.map(v => Math.round((v - mean) * 10) / 10), h: h.map(v => Math.round(v / n * 1e4) / 1e4) };
}
