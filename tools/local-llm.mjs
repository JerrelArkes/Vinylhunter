// Herkenning met een lokaal model op de agent-pc: route "lokaal" van de schakelaar in de app.
// Werkt met elke server die de OpenAI-chat-API spreekt met afbeeldingen: Ollama (http://localhost:11434/v1),
// LM Studio (http://localhost:1234/v1), llama.cpp-server, vLLM. Zelfde prompts en schema's als de
// Claude-routes (src/recognize.js, src/pokemon.js), zodat de Worker het antwoord op dezelfde manier verwerkt.
//
// Alleen herkenning (vinyl en Pokémon). Keramiek, zilver en overig vragen een analyse met veel naslag en
// een prijscheck met web search; die gaan in de lokale route via de Claude-API.
//
// Gemeten 2026-09-24 op een RTX 4090, 28 hoesfoto's: Gemma 4 31B 23/28 goed, Qwen3-VL-8B snel (0,9 s)
// maar 3 verkeerde platen; Claude Sonnet 5 27/28, Opus 5 28/28. Een verkeerde plaat geeft een verkeerde
// prijs, dus lokaal is vooral interessant als je geen API-kosten wilt en fouten voor lief neemt.
//
// Instellingen (agent.env): LOCAL_LLM_URL, LOCAL_LLM_MODEL, optioneel LOCAL_LLM_KEY en LOCAL_LLM_TIMEOUT_S.
import './env.mjs';
import { SYSTEM as VINYL_SYSTEM, SCHEMA as VINYL_SCHEMA } from '../src/recognize.js';
import { POKEMON_SYSTEM, POKEMON_SCHEMA } from '../src/pokemon.js';

export function localConfig() {
  const url = (process.env.LOCAL_LLM_URL || '').replace(/\/$/, '');
  const model = process.env.LOCAL_LLM_MODEL || '';
  if (!url || !model) return { ok: false, reden: 'LOCAL_LLM_URL en LOCAL_LLM_MODEL niet ingesteld (agent.env)' };
  return { ok: true, url, model, label: `lokaal:${model}` };
}

// Niet elke server kent response_format met een JSON-schema (of kent het maar negeert het). Daarom staat
// het schema ook in de prompt, en zoeken we het eerste JSON-object in het antwoord.
const jsonInstruction = schema => `\n\nAntwoord uitsluitend met één JSON-object volgens dit schema, zonder uitleg of codeblok:\n${JSON.stringify(schema)}`;

function parseJson(text) {
  const clean = String(text || '').replace(/```(?:json)?/gi, '');
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`geen JSON in het antwoord: ${clean.slice(0, 120)}`);
  return JSON.parse(clean.slice(start, end + 1));
}

// Ontbrekende velden aanvullen zodat de Worker altijd dezelfde vorm krijgt; een onbekende status telt
// als "unclear" (dan wordt er niets opgezocht, en dat is beter dan een gok).
function normalise(obj, schema) {
  const out = {};
  for (const [k, def] of Object.entries(schema.properties)) {
    let v = obj?.[k];
    if (def.type === 'string') v = v == null ? '' : String(v);
    if (def.enum && !def.enum.includes(v)) v = k === 'status' ? 'unclear' : def.enum.includes('unknown') ? 'unknown' : def.enum[0];
    out[k] = v;
  }
  return out;
}

async function chat(cfg, body) {
  const r = await fetch(`${cfg.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(process.env.LOCAL_LLM_KEY ? { Authorization: `Bearer ${process.env.LOCAL_LLM_KEY}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1000 * Number(process.env.LOCAL_LLM_TIMEOUT_S || 120)),
  });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`lokaal model ${r.status}: ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  return JSON.parse(text);
}

export async function runLocalJob(job, cfg = localConfig()) {
  if (!cfg.ok) throw new Error(cfg.reden);
  if (job.type !== 'herken') throw new Error(`lokaal model doet alleen herkenning, geen ${job.type}`);
  const [system, schema, question] = job.kind === 'pokemon'
    ? [POKEMON_SYSTEM, POKEMON_SCHEMA, 'Welke kaart is dit?'] : [VINYL_SYSTEM, VINYL_SCHEMA, 'Welke plaat is dit?'];
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 1500,
    messages: [
      { role: 'system', content: system + jsonInstruction(schema) },
      { role: 'user', content: [
        ...job.images.map(data => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } })),
        { type: 'text', text: question },
      ] },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'antwoord', schema, strict: true } },
  };
  const t0 = Date.now();
  let res;
  try {
    res = await chat(cfg, body);
  } catch (e) {
    // Server kent response_format niet: nog een keer zonder, het schema staat ook in de prompt.
    if (e.status !== 400 && e.status !== 422) throw e;
    const { response_format, ...zonder } = body;
    res = await chat(cfg, zonder);
  }
  const content = res.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map(c => c.text || '').join('') : content;
  return { result: normalise(parseJson(text), schema), ms: Date.now() - t0, model: cfg.label };
}
