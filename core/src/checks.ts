import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from './context.ts';
import { resolveModel } from './providers.ts';
import { jobAccess } from './providerApi.ts';

/** The oldest Claude Code Yaho is known to work with. */
export const MIN_CLAUDE_VERSION = '2.0.0';

export interface ClaudeCheck {
  checked_at: string;
  installed: boolean;
  version?: string;
  /** The version is at least MIN_CLAUDE_VERSION. */
  recent?: boolean;
  /** A real one-line run through Yaho's provider answered. */
  works?: boolean;
  model?: string;
  /** What went wrong, in the harness's own words where possible. */
  error?: string;
  /** Which part failed: the harness itself or the model provider behind it. */
  failed?: 'install' | 'version' | 'provider' | 'harness';
}

let last: ClaudeCheck | null = null;
export const lastClaudeCheck = () => last;

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child: ReturnType<typeof spawn>;
    try {
      // On Windows a command may be a .cmd shim, which only a shell can start.
      child = spawn(cmd, args, { env, cwd, shell: process.platform === 'win32', windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: (e as Error).message });
    }
    const timer = setTimeout(() => {
      err += `\ntimed out after ${timeoutMs / 1000} seconds`;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.stdin?.end();
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return true;
};

/**
 * Is Claude Code installed, recent enough, and able to answer through Yaho's provider? The last step is a real run,
 * started the way jobs start it, so it proves the key and the model as well.
 */
export async function checkClaude(ctx: Ctx): Promise<ClaudeCheck> {
  const cmd = ctx.settings.harnesses['claude-code']?.command ?? 'claude';
  const r: ClaudeCheck = { checked_at: new Date().toISOString(), installed: false };
  const env: NodeJS.ProcessEnv = {};
  const skip = /^(CLAUDECODE.*|CLAUDE_CODE_ENTRYPOINT|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|YAHO_PASSWORD|YAHO_SERVER)$/;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !skip.test(k)) env[k] = v;
  const dir = mkdtempSync(join(tmpdir(), 'yaho-check-'));
  try {
    const v = await run(cmd, ['--version'], env, dir, 20_000);
    if (v.code !== 0) {
      r.failed = 'install';
      r.error = `Claude Code was not found (${cmd}). Install it with: npm install -g @anthropic-ai/claude-code`;
      return (last = r);
    }
    r.installed = true;
    r.version = /\d+\.\d+\.\d+/.exec(v.out)?.[0] ?? v.out;
    r.recent = newer(r.version, MIN_CLAUDE_VERSION);
    if (!r.recent) {
      r.failed = 'version';
      r.error = `Claude Code ${r.version} is older than ${MIN_CLAUDE_VERSION}. Update it with: claude update`;
      return (last = r);
    }

    const chosen = ctx.settings.defaults.models[0];
    const resolved = chosen ? resolveModel(ctx.settings, chosen) : undefined;
    const model = resolved?.model;
    const access = resolved ? await jobAccess(ctx.settings, resolved.provider, { models: [], remaining: 0, agent: '', job: '' }).catch(() => null) : null;
    if (!model || !access) {
      r.failed = 'provider';
      r.error = 'Set the model provider (URL, key and a default model) first.';
      return (last = r);
    }
    r.model = model;
    // As jobs get it, but with the provider's own key, never a capped one minted for the check.
    const { env: providerEnv } = access;
    Object.assign(env, {
      ...providerEnv,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const t = await run(cmd, ['-p', 'Reply with the single word OK.', '--model', model], env, dir, 90_000);
    // Any answer counts: the model may phrase it its own way. Notices Claude Code prints on stderr are not errors.
    r.works = t.code === 0 && t.out.length > 0;
    if (!r.works) {
      const text = [t.out, t.err, `(exit code ${t.code})`].filter(Boolean).join('\n').slice(0, 1200);
      r.failed = /model|api|401|403|404|429|5\d\d|auth|key|connect|ECONN|fetch/i.test(text) ? 'provider' : 'harness';
      r.error = text;
    }
    return (last = r);
  } finally {
    // Windows may still hold the folder a moment after Claude Code exits; a leftover temp folder does no harm.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left for the OS to clean */
    }
  }
}
