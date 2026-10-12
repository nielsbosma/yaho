// OpenRouter's per-job keys with the management key from .plan/secrets.env: create one capped at $0.05, make a call
// with it, read its usage, delete it.   node --experimental-strip-types core/src/openrouterKeys.live.ts
import { readFileSync } from 'node:fs';
import type { ProviderConfig, Settings } from './config.ts';
import { jobAccess } from './providerApi.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../../.plan/secrets.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const p: ProviderConfig = { id: 'openrouter', kind: 'openrouter', api_key: env.OPENROUTER_API_KEY, master_key: env.OPENROUTER_MANAGEMENT_KEY };
const s = { providers: [p] } as unknown as Settings;
const access = await jobAccess(s, p, { models: [], remaining: 0.05, agent: 'live-check', job: `job_${Date.now()}` });
console.log(`budget: ${access.budget}, minted a job key: ${access.env.ANTHROPIC_AUTH_TOKEN !== p.api_key}`);
const info = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${access.env.ANTHROPIC_AUTH_TOKEN}` } }).then((r) => r.json());
console.log(`job key limit: $${info.data?.limit}, remaining $${info.data?.limit_remaining}`);
const call = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${access.env.ANTHROPIC_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 20 }),
});
console.log(`call with the job key: ${call.status} ${call.ok ? '' : (await call.text()).slice(0, 160)}`);
await new Promise((r) => setTimeout(r, 4000));
console.log(`spend read back: $${await access.capped!.spend()}`);
await access.capped!.release();
const gone = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${access.env.ANTHROPIC_AUTH_TOKEN}` } });
console.log(`after release, the job key answers: ${gone.status}`);
