// Leest agent.env (KEY=waarde per regel, # = commentaar) uit de projectmap in process.env. Waarden die
// al in de omgeving staan gaan voor. Importeer dit bestand als eerste, vóór modules die process.env lezen.
// Voorbeeld met uitleg: agent.env.example.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent.env');

if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
  }
}
