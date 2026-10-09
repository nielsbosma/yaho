import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { HarnessAdapter, HarnessEvent, HarnessProcess, HarnessRun } from './types.ts';

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

/** Claude Code in print mode with stream-json output. Models go through LiteLLM via ANTHROPIC_BASE_URL. */
export const claudeCode: HarnessAdapter = {
  name: 'claude-code',
  start(run: HarnessRun, onEvent: (e: HarnessEvent) => void): HarnessProcess {
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
      '--append-system-prompt',
      run.systemPrompt,
    ];
    if (run.resumeSessionId) args.push('--resume', run.resumeSessionId);
    const command = resolveCommand(run.command, run.env);
    const child = spawn(command, args, {
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
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        onEvent({ kind: 'text', text: line });
        return;
      }
      if (m.session_id && m.type === 'system') onEvent({ kind: 'session', sessionId: m.session_id as string });
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
        if (m.session_id) onEvent({ kind: 'session', sessionId: m.session_id as string });
        onEvent({
          kind: 'result',
          ok: !m.is_error,
          summary: typeof m.result === 'string' ? (m.result as string) : undefined,
          cost_usd: typeof m.total_cost_usd === 'number' ? (m.total_cost_usd as number) : undefined,
          error: m.is_error ? String(m.result ?? m.subtype ?? 'error') : undefined,
        });
      }
    });
    createInterface({ input: child.stderr }).on('line', (text) => text.trim() && onEvent({ kind: 'stderr', text }));

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

export const adapters: Record<string, HarnessAdapter> = { 'claude-code': claudeCode };
