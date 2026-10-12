// The Codex adapter on a real job, with the provider keys in .plan/secrets.env (spends a little; not in the test suite).
//   node --experimental-strip-types core/src/harness/codex.live.ts [openai|opper|litellm] [model]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig, Settings } from '../config.ts';
import { jobAccess } from '../providerApi.ts';
import { codex } from './codex.ts';
import type { HarnessEvent } from './types.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.plan/secrets.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const kind = process.argv[2] ?? 'openai';
const configs: Record<string, [ProviderConfig, string]> = {
  openai: [{ id: 'openai', kind: 'openai', api_key: env.OPENAI_API_KEY }, 'gpt-5-mini'],
  opper: [{ id: 'opper', kind: 'opper', api_key: env.OPPER_API_KEY }, 'openai/gpt-5-mini'],
  litellm: [{ id: 'litellm', kind: 'litellm', url: env.LITELLM_URL!.replace(/\/$/, ''), api_key: env.LITELLM_API_KEY }, 'gpt-6-luna'],
};
const [p, defaultModel] = configs[kind]!;
const model = process.argv[3] ?? defaultModel;
const s = { providers: [p] } as unknown as Settings;
const access = await jobAccess(s, p, { models: [model], remaining: 1, agent: 'live', job: '' });
const work = mkdtempSync(join(tmpdir(), 'yaho-codex-'));
const home = mkdtempSync(join(tmpdir(), 'yaho-codex-home-'));
const events: HarnessEvent[] = [];
const proc = codex.start(
  {
    command: 'codex',
    cwd: work,
    env: { ...(process.env as Record<string, string>), ...access.env, CODEX_HOME: home },
    model,
    systemPrompt: 'You are a Yaho agent.\nAlways end with the single word DONE.',
    prompt: 'Create a file named hello.txt containing exactly the text: codex-adapter',
  },
  (e) => events.push(e),
);
const code = await proc.done;
const count = (k: string) => events.filter((e) => e.kind === k).length;
console.log(`${kind} ${model}: exit ${code}; session ${count('session')}, text ${count('text')}, tool_use ${count('tool_use')}, tool_result ${count('tool_result')}, usage ${count('usage')}`);
console.log('result:', JSON.stringify(events.find((e) => e.kind === 'result')));
for (const e of events.filter((x) => x.kind === 'stderr')) console.log('stderr:', (e as { text: string }).text.slice(0, 160));
const file = join(work, 'hello.txt');
console.log(`hello.txt: ${existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : 'missing'}`);
for (const d of [work, home])
  try {
    rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Windows may still hold it */
  }
