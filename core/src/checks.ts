import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from './context.ts';
import { resolveModel } from './providers.ts';
import { harnessFits, jobAccess, listModels, type JobAccess } from './providerApi.ts';
import type { ProviderConfig } from './config.ts';
import { checkToken } from './bridge.ts';
import { codex } from './harness/codex.ts';
import { asAgent, jobEnv } from './harness/asAgent.ts';
import { resolveCommand } from './harness/claudeCode.ts';
import { compareVersions } from './updates.ts';
import type { HarnessEvent } from './harness/types.ts';

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

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  input = '',
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child: ReturnType<typeof spawn>;
    try {
      // Only a .cmd shim needs a shell (which splits arguments on spaces): keep its arguments to single words and send
      // anything longer over stdin.
      const full = resolveCommand(cmd, env);
      const shell = /\.(cmd|bat)$/i.test(full);
      child = spawn(...asAgent(shell && full.includes(' ') ? `"${full}"` : full, args), { env, cwd, shell, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: (e as Error).message });
    }
    const timer = setTimeout(() => {
      err += `\ntimed out after ${timeoutMs / 1000} seconds`;
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.stdin?.end(input);
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
  });
}

/** What one check may spend on a key minted for it. */
const CHECK_BUDGET_USD = 1;

/**
 * How a check's harness reaches the provider: as a job does, with a key minted and capped for the check where the
 * provider can (never the master key), and a bridge token for this one provider and model (never the human's token).
 */
async function checkAccess(
  ctx: Ctx,
  provider: ProviderConfig,
  model: string,
  harness: string,
): Promise<{ access: JobAccess; done(): void }> {
  const bridge = checkToken(provider.id, [model]);
  try {
    const access = await jobAccess(ctx.settings, provider, {
      models: [model],
      remaining: CHECK_BUDGET_USD,
      agent: 'check',
      job: `check-${Date.now().toString(36)}`,
      harness,
      bridge: { apiUrl: ctx.apiUrl, token: bridge.token },
    });
    return {
      access,
      done: () => {
        bridge.revoke();
        void access.capped?.release().catch(() => undefined);
      },
    };
  } catch (e) {
    bridge.revoke();
    throw e;
  }
}

/** At least the minimum version. */
const newer = (a: string, min: string) => compareVersions(a, min) >= 0;

/**
 * Is Claude Code installed, recent enough, and able to answer through Yaho's provider? The last step is a real run,
 * started the way jobs start it, so it proves the key and the model as well.
 */
export async function checkClaude(ctx: Ctx): Promise<ClaudeCheck> {
  const cmd = ctx.settings.harnesses['claude-code']?.command ?? 'claude';
  const r: ClaudeCheck = { checked_at: new Date().toISOString(), installed: false };
  const env: NodeJS.ProcessEnv = jobEnv();
  let done: () => void = () => undefined;
  const dir = mkdtempSync(join(tmpdir(), 'yaho-check-'));
  // On the server the check runs as the agents' user, who must be able to work in it.
  if (process.env.YAHO_AGENT_UID) chmodSync(dir, 0o777);
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
    if (!resolved || !model) {
      r.failed = 'provider';
      r.error = 'Set the model provider (URL, key and a default model) first.';
      return (last = r);
    }
    let providerEnv: Record<string, string>;
    try {
      const a = await checkAccess(ctx, resolved.provider, model, 'claude-code');
      providerEnv = a.access.env;
      done = a.done;
    } catch (e) {
      r.failed = 'provider';
      r.error = `Set the model provider (URL, key and a default model) first. (${(e as Error).message})`;
      return (last = r);
    }
    r.model = model;
    Object.assign(env, {
      ...providerEnv,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const t = await run(cmd, ['-p', '--model', model], env, dir, 90_000, 'Reply with the single word OK.');
    // Any answer counts: the model may phrase it its own way. Notices Claude Code prints on stderr are not errors.
    r.works = t.code === 0 && t.out.length > 0;
    if (!r.works) {
      const text = [t.out, t.err, `(exit code ${t.code})`].filter(Boolean).join('\n').slice(0, 1200);
      r.failed = /model|api|401|403|404|429|5\d\d|auth|key|connect|ECONN|fetch/i.test(text) ? 'provider' : 'harness';
      r.error = text;
    }
    return (last = r);
  } finally {
    done();
    // Windows may still hold the folder a moment after Claude Code exits; a leftover temp folder does no harm.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left for the OS to clean */
    }
  }
}

// ---------- Codex ----------

/** The oldest Codex Yaho is known to work with (its JSON events and -c provider settings). */
export const MIN_CODEX_VERSION = '0.150.0';
let lastCodex: ClaudeCheck | null = null;
export const lastCodexCheck = () => lastCodex;

/**
 * Is Codex installed, recent enough, and able to answer through Yaho's provider? The test run goes through the Codex
 * adapter, so it starts Codex exactly as a job does (provider over the Responses API, its own CODEX_HOME).
 */
export async function checkCodex(ctx: Ctx): Promise<ClaudeCheck> {
  const cmd = ctx.settings.harnesses.codex?.command ?? 'codex';
  const r: ClaudeCheck = { checked_at: new Date().toISOString(), installed: false };
  const env = jobEnv();
  let done: () => void = () => undefined;
  const dir = mkdtempSync(join(tmpdir(), 'yaho-check-'));
  // On the server the check runs as the agents' user, who must be able to work in it.
  if (process.env.YAHO_AGENT_UID) chmodSync(dir, 0o777);
  try {
    const v = await run(cmd, ['--version'], env, dir, 20_000);
    if (v.code !== 0) {
      r.failed = 'install';
      r.error = `Codex was not found (${cmd}). Install it with: npm install -g @openai/codex`;
      return (lastCodex = r);
    }
    r.installed = true;
    r.version = /\d+\.\d+\.\d+/.exec(v.out)?.[0] ?? v.out;
    r.recent = newer(r.version, MIN_CODEX_VERSION);
    if (!r.recent) {
      r.failed = 'version';
      r.error = `Codex ${r.version} is older than ${MIN_CODEX_VERSION}. Update it with: npm install -g @openai/codex@latest`;
      return (lastCodex = r);
    }
    const chosen = ctx.settings.defaults.models[0];
    const resolved = chosen ? resolveModel(ctx.settings, chosen) : undefined;
    if (!resolved) {
      r.failed = 'provider';
      r.error = 'Set the model provider (key and a default model) first.';
      return (lastCodex = r);
    }
    if (!harnessFits(resolved.provider, 'codex')) {
      r.failed = 'provider';
      r.error = `Codex needs a provider with OpenAI's Responses API (OpenAI, LiteLLM, Opper or OpenRouter); the default model is on ${resolved.provider.id}.`;
      return (lastCodex = r);
    }
    // Codex is built for OpenAI's models; Claude through a proxy's Responses route often refuses its requests. Test
    // with a GPT model: one from the default models, or else the first the provider offers.
    const gpt = (m: string) => /(^|\/)(gpt|o\d|codex)/i.test(m);
    let model = resolved.model;
    if (!gpt(model)) {
      const fromDefaults = ctx.settings.defaults.models
        .map((m) => resolveModel(ctx.settings, m))
        .find((x) => x.provider.id === resolved.provider.id && gpt(x.model));
      model = fromDefaults?.model ?? (await listModels(ctx.settings, resolved.provider).catch(() => [] as string[])).find(gpt) ?? model;
    }
    r.model = model;
    let access: JobAccess;
    try {
      ({ access, done } = await checkAccess(ctx, resolved.provider, model, 'codex'));
    } catch (e) {
      r.failed = 'provider';
      r.error = (e as Error).message;
      return (lastCodex = r);
    }
    const events: HarnessEvent[] = [];
    const proc = codex.start(
      {
        command: cmd,
        cwd: dir,
        env: { ...env, ...access.env, CODEX_HOME: join(ctx.paths.root, 'codex') },
        model,
        systemPrompt: 'Answer in one word.',
        prompt: 'Reply with the single word OK.',
      },
      (e) => events.push(e),
    );
    const timer = setTimeout(() => proc.kill(), 120_000);
    await proc.done;
    clearTimeout(timer);
    const result = events.find((e) => e.kind === 'result') as { ok: boolean; summary?: string; error?: string } | undefined;
    r.works = !!result?.ok && !!result.summary;
    if (!r.works) {
      const notes = events.filter((e) => e.kind === 'stderr').map((e) => (e as { text: string }).text);
      const text = [result?.error, ...notes].filter(Boolean).join('\n').slice(0, 1200) || 'Codex gave no answer';
      r.failed = /model|api|401|403|404|429|5\d\d|auth|key|connect|ECONN|fetch|stream/i.test(text) ? 'provider' : 'harness';
      r.error = text;
    }
    return (lastCodex = r);
  } finally {
    done();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* left for the OS to clean */
    }
  }
}
