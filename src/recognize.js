// Hoesfoto -> artiest, titel, catno. Eén Claude-aanroep met gestructureerde uitvoer (src/claude.js).
import { askJson } from './claude.js';

// Geëxporteerd voor tools/claude-cli.mjs en tools/local-llm.mjs: elke route krijgt precies dezelfde vraag.
export const SYSTEM = `Je krijgt een foto uit een kringloopwinkel: meestal een hoes van een vinylplaat (single of LP), soms een kale plaat of een witte binnenhoes met het label zichtbaar.

Lees de voorste, meest complete hoes of het label af. De foto kan gedraaid zijn.
- Artiest en titel letterlijk zoals ze op de hoes staan, in de taal van de hoes. Niet vertalen en niet aanvullen of verbeteren uit eigen kennis: een naam of titel die je niet kent neem je over zoals hij er staat, ook als je een bekendere vermoedt.
- Bij een single is de titel de A-kant; zet de B-kant in other_side als die zichtbaar is.
- catno: het catalogusnummer als het leesbaar is (vaak klein bij het labellogo, bijv. "6012 456", "TS 1774", "881792-7"). Niet gokken; leeg laten als je het niet zeker leest.
- label: platenmaatschappij als die zichtbaar is.
- Negeer prijsstickers, winkelstickers en wat door het middengat van een label zichtbaar is.

status:
- "ok": artiest en titel zijn leesbaar.
- "unclear": er is een plaat maar je kunt artiest of titel niet betrouwbaar lezen (bewogen, half in beeld, twee hoezen door elkaar).
- "no_record": geen plaat in beeld.`;

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'artist', 'title', 'other_side', 'catno', 'label', 'format'],
  properties: {
    status: { type: 'string', enum: ['ok', 'unclear', 'no_record'] },
    artist: { type: 'string' },
    title: { type: 'string' },
    other_side: { type: 'string' },
    catno: { type: 'string' },
    label: { type: 'string' },
    format: { type: 'string', enum: ['single', 'lp', 'unknown'] },
  },
};

export function recognize(apiKey, model, jpegBase64) {
  return askJson(apiKey, { model, system: SYSTEM, schema: SCHEMA, images: [jpegBase64], text: 'Welke plaat is dit?' });
}
