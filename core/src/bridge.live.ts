// Claude Code on Berget or OpenAI through the core's bridge, with the key from .plan/secrets.env (spends a little; not in the
// test suite).   node --experimental-strip-types core/src/bridge.live.ts [model]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { serve } from './serve.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../../.plan/secrets.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const kind = process.argv[3] ?? 'berget';
const model = process.argv[2] ?? 'moonshotai/Kimi-K3';
const dir = mkdtempSync(join(tmpdir(), 'yaho-bridge-'));
writeFileSync(join(dir, 'settings.yaml'), YAML.stringify({ providers: [{ id: kind, kind, api_key: env[`${kind.toUpperCase()}_API_KEY`] }] }));
process.env.YAHO_NO_DOPBASE = '1';
const { ctx, close } = await serve({ dataDir: dir, port: 0, host: '127.0.0.1', embedded: true });

const work = mkdtempSync(join(tmpdir(), 'yaho-bridge-work-'));
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDECODE.*|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_.*)$/.test(k)) childEnv[k] = v;
Object.assign(childEnv, {
  ANTHROPIC_BASE_URL: `${ctx.apiUrl}/bridge/${kind}`,
  ANTHROPIC_AUTH_TOKEN: ctx.apiToken,
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  ANTHROPIC_SMALL_FAST_MODEL: model,
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
process.env.YAHO_DEBUG = '1';
const prompt = 'Create a file named hello.txt in the current folder containing exactly the text: bridged. Then reply DONE.';
// Not spawnSync: the core answers in this same process, so it must keep running while Claude Code works.
const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const child = spawn('claude', ['-p', JSON.stringify(prompt), '--model', model, '--output-format', 'json', '--permission-mode', 'acceptEdits'], { cwd: work, env: childEnv, shell: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), 240_000);
  child.on('close', (status) => {
    clearTimeout(timer);
    resolve({ status, stdout, stderr });
  });
});
let summary = r.stdout.trim().slice(0, 400);
try {
  const o = JSON.parse(r.stdout);
  summary = `result=${JSON.stringify(String(o.result).slice(0, 120))} turns=${o.num_turns} is_error=${o.is_error} usage=${JSON.stringify(o.usage ? { in: o.usage.input_tokens, out: o.usage.output_tokens } : null)}`;
} catch {
  /* raw output above */
}
const file = join(work, 'hello.txt');
console.log(`${model}: exit ${r.status} ${summary}`);
console.log(`hello.txt: ${existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : 'missing'}`);
if (r.stderr.trim()) console.log(`stderr: ${r.stderr.replace(/\s+/g, ' ').slice(0, 300)}`);
await close();
rmSync(dir, { recursive: true, force: true });
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
} catch {
  /* Windows may still hold it */
}
