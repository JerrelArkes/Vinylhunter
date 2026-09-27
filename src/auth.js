// Wachtwoordlogin (tijdelijk, voor het testpanel) naast Cloudflare Access.
// Sessie = cookie "vinyl_session" met vervaltijd + HMAC. De HMAC-sleutel is afgeleid van het
// wachtwoord: wachtwoord wijzigen maakt alle bestaande sessies ongeldig.
import { verifyAccess } from './access.js';

const COOKIE = 'vinyl_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 3;
const LOCK_MS = 3600_000;

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode('vinyl-session:' + env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function validSession(request, env) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!sig || Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await sign(env, exp));
}

export async function isAuthed(request, env) {
  if (env.DEV_NO_AUTH === '1') return true;
  if (env.APP_PASSWORD && await validSession(request, env)) return true;
  if (env.ACCESS_TEAM && env.ACCESS_AUD && await verifyAccess(request, env)) return true;
  return false;
}

export const authConfigured = env => env.DEV_NO_AUTH === '1' || !!env.APP_PASSWORD || !!(env.ACCESS_TEAM && env.ACCESS_AUD);

const clientIp = request => request.headers.get('cf-connecting-ip') || 'lokaal';

/** @returns {Promise<Response>} */
export async function login(request, env, json) {
  if (!env.APP_PASSWORD) return json({ error: 'Wachtwoordlogin staat uit' }, 404);
  const ip = clientIp(request), now = Date.now();
  const row = await env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row?.locked_until > now) {
    const min = Math.ceil((row.locked_until - now) / 60000);
    return json({ error: `Te vaak fout. Probeer het over ${min} minuten opnieuw.`, locked: true }, 429);
  }
  const { password } = await request.json().catch(() => ({}));
  if (typeof password === 'string' && timingSafeEqual(password, env.APP_PASSWORD)) {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    const exp = String(now + SESSION_DAYS * 86400_000);
    const cookie = `${COOKIE}=${exp}.${await sign(env, exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
    const res = json({ ok: true });
    res.headers.append('Set-Cookie', cookie);
    return res;
  }
  // Na een verlopen blokkade opnieuw beginnen met tellen.
  const fails = (row && !(row.locked_until && row.locked_until <= now) ? row.fails : 0) + 1;
  const locked = fails >= MAX_FAILS ? now + LOCK_MS : null;
  await env.DB.prepare(
    'INSERT INTO login_attempts (ip, fails, locked_until, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET fails = excluded.fails, locked_until = excluded.locked_until, last_at = excluded.last_at'
  ).bind(ip, fails, locked, now).run();
  if (locked) return json({ error: 'Drie keer fout. Je kunt het over een uur opnieuw proberen.', locked: true }, 429);
  const left = MAX_FAILS - fails;
  return json({ error: `Onjuist wachtwoord. Nog ${left} ${left === 1 ? 'poging' : 'pogingen'}.`, left }, 401);
}
