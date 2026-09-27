// Eén Claude-aanroep met gestructureerde uitvoer (JSON volgens schema), gedeeld door alle standen:
// vinyl en Pokémon (één foto, snel), keramiek en zilver (meerdere foto's, Opus, eventueel web search).
import Anthropic from '@anthropic-ai/sdk';

// Prijzen in $ per miljoen tokens (invoer, uitvoer), voor de kostenregels in logs en testscripts.
const RATES = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5] };
const SEARCH_USD = 0.01;                  // web search: $10 per 1000 zoekopdrachten

export function costUsd(model, u) {
  const [inp, out] = RATES[model] || RATES['claude-opus-5'];
  if (!u) return 0;
  return ((u.input_tokens || 0) * inp + (u.cache_creation_input_tokens || 0) * inp * 1.25
    + (u.cache_read_input_tokens || 0) * inp * 0.1 + (u.output_tokens || 0) * out) / 1e6
    + (u.server_tool_use?.web_search_requests || 0) * SEARCH_USD;
}

function addUsage(total, u) {
  if (!u) return total;
  const t = total || { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0 } };
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) t[k] += u[k] || 0;
  t.server_tool_use.web_search_requests += u.server_tool_use?.web_search_requests || 0;
  return t;
}

// Met web search kan er vóór de JSON nog losse tekst staan; neem dan het laatste JSON-object.
function parseJson(texts) {
  for (const s of [texts.join(''), texts.at(-1)]) {
    try { return JSON.parse(s); } catch {}
  }
  const s = texts.at(-1), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
  throw new Error('Antwoord was geen JSON');
}

export async function askJson(apiKey, {
  model, system, schema, images = [], text, effort = 'low', maxTokens = 2000, timeout = 25_000,
  retries = 1, cacheSystem = false, tools = null,
}) {
  const client = new Anthropic({ apiKey, maxRetries: retries, timeout });
  // Niet elk model kent dezelfde opties: Haiku 4.5 geeft een 400 op effort, en de server-side
  // fallback (bij een weigering een ander model laten antwoorden) hoort bij Opus en Fable.
  const fallback = /^claude-(opus|fable)/.test(model);
  const params = {
    model,
    max_tokens: maxTokens,
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    output_config: {
      ...(model.startsWith('claude-haiku') ? {} : { effort }),
      format: { type: 'json_schema', schema },
    },
    // Lange vaste prompt (naslag keramiek/zilver): cachen, dan kost een tweede stuk binnen 5 min ~10%.
    system: cacheSystem ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
    ...(tools ? { tools } : {}),
  };
  let messages = [{
    role: 'user',
    content: [
      ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'text', text },
    ],
  }];
  let response, usage = null;
  // Met web search kan de server zijn lus pauzeren (pause_turn): dan het antwoord ongewijzigd
  // terugsturen en hij gaat verder. Begrensd, zodat een haperende zoektocht niet eindeloos kost.
  for (let round = 0; round < 3; round++) {
    response = await client.beta.messages.create({ ...params, messages });
    usage = addUsage(usage, response.usage);
    if (response.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: response.content }];
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude weigerde de foto');
  const texts = response.content.filter(b => b.type === 'text').map(b => b.text);
  if (!texts.length) throw new Error(`Geen antwoord (stop_reason ${response.stop_reason})`);
  return { ...parseJson(texts), usage, model };
}
