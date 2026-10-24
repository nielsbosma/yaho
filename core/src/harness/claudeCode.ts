import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HarnessAdapter, HarnessEvent, HarnessProcess, HarnessRun } from './types.ts';
import { asAgent } from './asAgent.ts';
import { claudeSandboxSettings } from './sandbox.ts';
import { writeFileUnder } from '../fsSafe.ts';

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join('\n');
  return JSON.stringify(content);
}

/** Find a command on PATH (with PATHEXT on Windows) so we can spawn it without a shell. */
export function resolveCommand(cmd: string, env: Record<string, string | undefined> = process.env): string {
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return cmd;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (env[pathKey] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' && extname(cmd) ? ['', ...exts] : exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return cmd;
}

/**
 * Appends each raw output line to the run's transcript, in the workspace (cwd), never through a link the agent put
 * there. A transcript that cannot be written is reported once and then skipped; the job goes on.
 */
export function transcriptWriter(run: HarnessRun, onEvent: (e: HarnessEvent) => void): (line: string) => void {
  let path = run.transcriptPath;
  return (line) => {
    if (!path) return;
    try {
      writeFileUnder(run.cwd, path, `${line}\n`, { append: true });
    } catch (e) {
      onEvent({ kind: 'stderr', text: `transcript not kept: ${(e as Error).message}` });
      path = undefined;
    }
  };
}

/** Kill a process and its whole tree; on Windows a plain kill leaves the harness's children running. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

/** Claude Code's --settings for a job: the sandbox, and the Command Rules hook on Bash. Null when neither is on. */
export function claudeSettings(run: Pick<HarnessRun, 'sandbox' | 'commandGuard'>): Record<string, unknown> | null {
  if (!run.sandbox && !run.commandGuard) return null;
  const base = run.sandbox ? claudeSandboxSettings(run.sandbox.guard, run.sandbox) : {};
  const pre = ((base.hooks as { PreToolUse?: unknown[] } | undefined)?.PreToolUse ?? []).slice();
  if (run.commandGuard) pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command: run.commandGuard }] });
  return { ...base, hooks: { PreToolUse: pre } };
}

/** Claude Code in print mode with stream-json output. Models go through LiteLLM via ANTHROPIC_BASE_URL. */
export const claudeCode: HarnessAdapter = {
  name: 'claude-code',
  start(run: HarnessRun, onEvent: (e: HarnessEvent) => void): HarnessProcess {
    const settings = claudeSettings(run);
    const args = [
      ...(run.args ?? []),
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      run.model,
      '--permission-mode',
      'bypassPermissions',
      // No settings files: the workspace's .claude/settings*.json and the agents' own ~/.claude are the agent's to
      // write, and could turn Yaho's hooks or sandbox off. Only what Yaho passes here applies.
      '--setting-sources=',
      ...(settings ? ['--settings', JSON.stringify(settings)] : []),
    ];
    // The system prompt goes in a file when it can: Windows command lines cap at 32k characters.
    if (run.systemPromptPath) {
      writeFileUnder(run.cwd, run.systemPromptPath, run.systemPrompt);
      args.push('--append-system-prompt-file', run.systemPromptPath);
    } else args.push('--append-system-prompt', run.systemPrompt);
    if (run.mcp) {
      const { command, args: mcpArgs, env, configPath } = run.mcp;
      writeFileSync(configPath, JSON.stringify({ mcpServers: { yaho: { type: 'stdio', command, args: mcpArgs, env } } }));
      args.push('--mcp-config', configPath);
    }
    if (run.resumeSessionId) args.push('--resume', run.resumeSessionId);
    // Claude Code stops itself once its own spend estimate reaches this; Yaho passes what the agent has left.
    if (run.maxBudgetUsd !== undefined) args.push('--max-budget-usd', run.maxBudgetUsd.toFixed(4));
    const command = resolveCommand(run.command, run.env);
    const child = spawn(...asAgent(command, args), {
      cwd: run.cwd,
      env: run.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Only batch files need a shell; everything else is spawned directly so arguments pass through untouched.
      shell: /\.(cmd|bat)$/i.test(command),
      detached: process.platform !== 'win32',
    });
    // The prompt goes over stdin: Windows command lines cap at 32k characters.
    child.stdin.end(run.prompt);

    let gotResult = false;
    const transcript = transcriptWriter(run, onEvent);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      transcript(line);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        onEvent({ kind: 'text', text: line });
        return;
      }
      if (m.session_id && m.type === 'system') onEvent({ kind: 'session', sessionId: m.session_id as string });
      if (m.type === 'assistant') {
        const msg = m.message as { id?: string; usage?: Record<string, number> } | undefined;
        if (msg?.id && msg.usage)
          onEvent({
            kind: 'usage',
            id: msg.id,
            input: msg.usage.input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
            cache_read: msg.usage.cache_read_input_tokens ?? 0,
            cache_write: msg.usage.cache_creation_input_tokens ?? 0,
          });
      }
      if (m.type === 'assistant' || m.type === 'user') {
        const content = ((m.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === 'text' && c.text) onEvent({ kind: 'text', text: c.text as string });
          else if (c.type === 'tool_use') onEvent({ kind: 'tool_use', name: c.name as string, input: c.input, id: c.id as string });
          else if (c.type === 'tool_result')
            onEvent({ kind: 'tool_result', id: c.tool_use_id as string, output: clip(toolResultText(c.content)), is_error: !!c.is_error });
        }
      }
      if (m.type === 'result') {
        gotResult = true;
        // A failed run can still say subtype "success" (an API error ends the turn normally); name only real error kinds.
        const kind = String(m.subtype ?? '').startsWith('error') ? (m.subtype as string) : undefined;
        if (m.session_id) onEvent({ kind: 'session', sessionId: m.session_id as string });
        onEvent({
          kind: 'result',
          ok: !m.is_error && !String(m.subtype ?? '').startsWith('error'),
          summary: typeof m.result === 'string' ? (m.result as string) : undefined,
          cost_usd: typeof m.total_cost_usd === 'number' ? (m.total_cost_usd as number) : undefined,
          error:
            m.is_error || String(m.subtype ?? '').startsWith('error') ? [kind, m.result].filter(Boolean).join(': ') || 'error' : undefined,
        });
      }
    });
    // Claude Code warns that a proxy key overrides the claude.ai login; for Yaho that is the point.
    const noise = /claude\.ai connectors are disabled/;
    createInterface({ input: child.stderr }).on('line', (text) => text.trim() && !noise.test(text) && onEvent({ kind: 'stderr', text }));

    const done = new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        onEvent({ kind: 'result', ok: false, error: `could not start ${run.command}: ${err.message}` });
        resolve(null);
      });
      child.on('close', (code) => {
        if (!gotResult && code !== 0 && code !== null) onEvent({ kind: 'result', ok: false, error: `harness exited with code ${code}` });
        resolve(code);
      });
    });
    return { pid: child.pid, done, kill: () => killTree(child.pid) };
  },
};
