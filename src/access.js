// Controle van de Cloudflare Access-JWT. Access schermt de pagina's al af aan de rand;
// dit is de tweede slot op de API, zodat een verkeerd ingestelde Access-regel geen
// open scan-endpoint (en dus kosten) oplevert.

let certCache = { team: null, keys: null, fetched: 0 };

async function getKeys(team) {
  if (certCache.team === team && Date.now() - certCache.fetched < 3600_000) return certCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access certs ${r.status}`);
  const { keys } = await r.json();
  certCache = { team, keys, fetched: Date.now() };
  return keys;
}

const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));

function tokenFrom(request) {
  const h = request.headers.get('cf-access-jwt-assertion');
  if (h) return h;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

/** @returns {Promise<string|null>} e-mailadres bij geldige token, anders null */
export async function verifyAccess(request, env) {
  const team = env.ACCESS_TEAM, aud = env.ACCESS_AUD;
  if (!team || !aud) return null;
  const token = tokenFrom(request);
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  const jwk = (await getKeys(team)).find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return null;
  return payload.email || 'onbekend';
}
