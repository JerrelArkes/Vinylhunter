// Schrijft .dev.vars (voor `wrangler dev`) uit de sleutelbestanden, zonder ze te tonen.
// Draaien: node tools/make-dev-vars.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export function readKeys() {
  const discogs = readFileSync(join(root, 'token.env.txt'), 'utf8').trim();
  // claude-token.env.txt bevat meerdere "label: waarde"-regels; de sleutel is de sk-ant-waarde.
  const anthropic = readFileSync(join(root, 'claude-token.env.txt'), 'utf8').match(/sk-ant-[A-Za-z0-9_-]+/)?.[0];
  if (!anthropic) throw new Error('Geen sk-ant-sleutel gevonden in claude-token.env.txt');
  return { discogs, anthropic };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { discogs, anthropic } = readKeys();
  // AGENT_KEY erbij (als agent-key.txt er is): dan kan een test-agent tegen wrangler dev draaien.
  const agentFile = join(root, 'agent-key.txt');
  const agent = existsSync(agentFile) ? readFileSync(agentFile, 'utf8').trim() : '';
  writeFileSync(join(root, '.dev.vars'), `ANTHROPIC_API_KEY=${anthropic}\nDISCOGS_TOKEN=${discogs}\nDEV_NO_AUTH=1\n${agent ? `AGENT_KEY=${agent}\n` : ''}`);
  console.log(`.dev.vars geschreven (Anthropic-sleutel ${anthropic.length} tekens, Discogs-token ${discogs.length} tekens${agent ? ', AGENT_KEY erbij' : ''}).`);
}
