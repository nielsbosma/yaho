// End-to-end test of a running Yaho (desktop core or server image) with the keys in .plan/secrets.env. Spends a
// little on each provider. Prints results, never keys.
//   node tools/e2e.mjs --url http://127.0.0.1:4799 --password <server password> [--totp <authenticator key>]
// A server whose authenticator is not set up yet gets one set up, and its key printed for the next run.
//   node tools/e2e.mjs --url http://127.0.0.1:4791 --token <api token>
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { totp } from './totp.mjs';

const { values: o } = parseArgs({ options: { url: { type: 'string' }, password: { type: 'string' }, totp: { type: 'string' }, token: { type: 'string' }, only: { type: 'string' } } });
const U = o.url ?? 'http://127.0.0.1:4799';
const env = Object.fromEntries(
  readFileSync(new URL('../.plan/secrets.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const results = [];
const pass = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
};

let cookie = '';
async function call(path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : { Cookie: cookie }), ...init.headers };
  const r = await fetch(U + path, { ...init, headers });
  const sc = r.headers.get('set-cookie');
  if (sc && !o.token) cookie = sc.split(';')[0];
  const t = await r.text();
  let body = t;
  try {
    body = t ? JSON.parse(t) : null;
  } catch {
    /* text */
  }
  return { status: r.status, body };
}

// ---- 1. Reachable, and closed without credentials ----
pass('health answers', (await fetch(`${U}/api/health`)).ok);
const open = await fetch(`${U}/api/agents`);
pass('API refuses requests without credentials', open.status === 401, `${open.status}`);
if (o.password) {
  const wrong = await call('/api/session', { method: 'POST', body: JSON.stringify({ password: 'definitely not it' }) });
  pass('wrong password refused', wrong.status === 401);
  const ok = await call('/api/session', { method: 'POST', body: JSON.stringify({ password: o.password, code: o.totp && totp(o.totp) }) });
  pass('signs in with the password', ok.status === 200 && !!cookie);
  if (ok.body?.totp_setup) {
    const { secret } = (await call('/api/session/totp')).body;
    const set = await call('/api/session/totp', { method: 'POST', body: JSON.stringify({ code: totp(secret) }) });
    pass('sets up the authenticator', set.status === 200, `key ${secret}: pass --totp ${secret} next time`);
  }
}

// ---- 2. Providers ----
const s = (await call('/api/settings')).body;
const want = {
  litellm: { url: env.LITELLM_URL.replace(/\/$/, ''), api_key: env.LITELLM_API_KEY },
  opper: { api_key: env.OPPER_API_KEY },
  berget: { api_key: env.BERGET_API_KEY },
  openai: { api_key: env.OPENAI_API_KEY },
};
for (const [kind, fields] of Object.entries(want)) {
  let p = s.providers.find((x) => x.kind === kind);
  if (!p) s.providers.push((p = { id: kind, kind }));
  Object.assign(p, fields);
}
s.default_provider = 'litellm';
s.defaults.models = ['claude-haiku-5-5'];
s.defaults.harness = 'claude-code';
s.onboarded_at ??= new Date().toISOString();
const put = await call('/api/settings', { method: 'PUT', body: JSON.stringify(s) });
pass('providers saved', put.status === 200, `${put.status}`);
const pub = JSON.stringify((await call('/api/settings')).body);
const leaked = Object.values(want).some((f) => f.api_key && pub.includes(f.api_key));
pass('no key in the settings the UI receives', !leaked);
const models = (await call('/api/models')).body;
const per = {};
for (const id of Object.values(models.provider_of ?? {})) per[id] = (per[id] ?? 0) + 1;
pass('every provider lists models', ['litellm', 'opper', 'berget', 'openai'].every((id) => per[id] > 0), JSON.stringify(per));

// ---- 3. Harness checks ----
for (const h of ['claude-code', 'codex']) {
  const c = (await call(`/api/checks/${h}`, { method: 'POST' })).body ?? {};
  pass(`${h} check`, !!c.works, c.works ? `${c.version}, ${c.model}` : String(c.error ?? '').slice(0, 140));
}

// ---- 4. The chat, with a tool ----
const chat = await call('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'List my agents with your tool, then say how many there are.' }] }) });
const steps = chat.body?.steps ?? [];
pass('chat answers and uses a tool', chat.status === 200 && steps.some((x) => x.tool === 'list_agents'), `${steps.map((x) => x.tool).join(', ')}`);

// ---- 5. Real jobs: each must send an inbox message through the yaho CLI ----
const matrix = [
  ['claude-code', 'claude-haiku-5-5', 'LiteLLM'],
  ['claude-code', 'opper/anthropic/claude-haiku-4-5', 'Opper'],
  ['claude-code', 'berget/moonshotai/Kimi-K3', 'Berget (bridge)'],
  ['claude-code', 'openai/gpt-5-mini', 'OpenAI (bridge)'],
  ['codex', 'gpt-6-luna', 'LiteLLM'],
  ['codex', 'openai/gpt-5-mini', 'OpenAI'],
].filter(([h, , label]) => !o.only || `${h} ${label}`.toLowerCase().includes(o.only.toLowerCase()));
const runId = Date.now().toString(36);
const jobs = await Promise.all(
  matrix.map(async ([harness, model, label], i) => {
    const name = `e2e-${runId}-${i}`;
    const title = `E2E ${runId} ${i}`;
    const briefing = `You are a test agent. Do exactly this and nothing else:\n1. Run this shell command: yaho send --to human --type info --title "${title}" --body "ok from ${harness} on ${label}"\n2. Run: yaho finish --summary done\nDo not create any files.`;
    const created = await call('/api/agents', { method: 'POST', body: JSON.stringify({ name, briefing, harness, models: [model], enabled: false, budget_usd: 1 }) });
    if (created.status !== 200) return { harness, label, name, title, error: `create ${created.status} ${JSON.stringify(created.body).slice(0, 120)}` };
    const run = await call(`/api/agents/${name}/run`, { method: 'POST', body: JSON.stringify({}) });
    return { harness, label, name, title, job: run.body?.id ?? run.body?.job?.id, runStatus: run.status, runBody: run.body };
  }),
);
const ENDED = ['finished', 'sleeping', 'failed', 'budget_exhausted', 'stopped'];
const deadline = Date.now() + 8 * 60_000;
for (const j of jobs) {
  if (j.error) {
    pass(`job: ${j.harness} on ${j.label}`, false, j.error);
    continue;
  }
  let job = null;
  while (Date.now() < deadline) {
    const list = (await call(`/api/jobs?agent=${j.name}`)).body ?? [];
    job = Array.isArray(list) ? list[0] : null;
    if (job && ENDED.includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const inbox = (await call('/api/messages?to=human')).body ?? [];
  const msg = (Array.isArray(inbox) ? inbox : []).find((m) => m.title === j.title);
  const ok = !!job && job.status === 'finished' && !!msg;
  pass(`job: ${j.harness} on ${j.label}`, ok, job ? `${job.status}${job.reason ? ` (${String(job.reason).slice(0, 100)})` : ''}, cost $${Number(job.cost_usd).toFixed(4)}, message ${msg ? 'arrived' : 'missing'}` : `no job (${j.runStatus})`);
}

// ---- 6. Clean up the test agents and their messages ----
for (const j of jobs) await call(`/api/agents/${j.name}`, { method: 'DELETE' });
const inbox = (await call('/api/messages?to=human')).body ?? [];
for (const m of (Array.isArray(inbox) ? inbox : []).filter((x) => String(x.title).startsWith(`E2E ${runId}`))) await call(`/api/messages/${m.id}`, { method: 'DELETE' });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
