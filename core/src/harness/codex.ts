import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { asAgent } from './asAgent.ts';
import { killTree, resolveCommand } from './claudeCode.ts';
import type { HarnessAdapter, HarnessEvent, HarnessProcess, HarnessRun } from './types.ts';

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);
const toml = (s: string) => JSON.stringify(s); // a TOML basic string has JSON's escapes

/**
 * On Windows npm installs codex as a .cmd script, which only runs through a shell, and a shell would mangle the quoted
 * settings and the multi-line instructions. Run its JavaScript entry with Node instead when it is next to the script.
 */
function direct(command: string): [string, string[]] {
  if (!/\.cmd$/i.test(command)) return [command, []];
  const js = join(dirname(command), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!existsSync(js)) throw new Error(`cannot run ${command} without a shell: reinstall Codex with npm install -g @openai/codex`);
  return [process.execPath, [js]];
}

/**
 * OpenAI's Codex CLI (codex exec --json). It reaches the model through OpenAI's Responses API: the runner gives the
 * provider's address and key as YAHO_CODEX_BASE_URL and YAHO_MODEL_KEY, which become a "yaho" model provider here, so
 * the person's own ~/.codex/config.toml is never used. The agent's system prompt goes in as developer instructions.
 */
export const codex: HarnessAdapter = {
  name: 'codex',
  start(run: HarnessRun, onEvent: (e: HarnessEvent) => void): HarnessProcess {
    const base = run.env.YAHO_CODEX_BASE_URL;
    const common = [
      '--json',
      '--skip-git-repo-check',
      // Jobs run unattended in the agent's own workspace, as Claude Code's bypassPermissions does.
      '--dangerously-bypass-approvals-and-sandbox',
      '--ignore-user-config',
      '-m',
      run.model,
      '-c',
      `model_providers.yaho={name="Yaho",base_url=${toml(base ?? '')},env_key="YAHO_MODEL_KEY",wire_api="responses"}`,
      '-c',
      'model_provider="yaho"',
      '-c',
      `developer_instructions=${toml(run.systemPrompt)}`,
    ];
    const args = [...(run.args ?? []), 'exec', ...(run.resumeSessionId ? ['resume', ...common, run.resumeSessionId] : [...common, '-C', run.cwd]), '-'];
    if (run.env.CODEX_HOME) mkdirSync(run.env.CODEX_HOME, { recursive: true });
    const [command, prefix] = direct(resolveCommand(run.command, run.env));
    const child = spawn(...asAgent(command, [...prefix, ...args]), {
      cwd: run.cwd,
      env: run.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    // The prompt over stdin ("-"): Windows command lines cap at 32k characters.
    child.stdin.end(run.prompt);

    let gotResult = false;
    let lastMessage = '';
    let usageCount = 0;
    if (!base) onEvent({ kind: 'stderr', text: 'no model provider address for Codex (YAHO_CODEX_BASE_URL)' });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      if (run.transcriptPath) appendFileSync(run.transcriptPath, `${line}\n`);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        onEvent({ kind: 'text', text: line });
        return;
      }
      const item = m.item as Record<string, unknown> | undefined;
      switch (m.type) {
        case 'thread.started':
          onEvent({ kind: 'session', sessionId: String(m.thread_id) });
          break;
        case 'item.started':
          if (item?.type === 'command_execution') onEvent({ kind: 'tool_use', id: String(item.id), name: 'shell', input: { command: item.command } });
          if (item?.type === 'mcp_tool_call') onEvent({ kind: 'tool_use', id: String(item.id), name: String(item.tool ?? 'tool'), input: item.arguments });
          break;
        case 'item.completed':
          if (item?.type === 'agent_message' && item.text) {
            lastMessage = String(item.text);
            onEvent({ kind: 'text', text: lastMessage });
          } else if (item?.type === 'command_execution')
            onEvent({ kind: 'tool_result', id: String(item.id), output: clip(String(item.aggregated_output ?? '')), is_error: item.exit_code !== 0 });
          else if (item?.type === 'file_change') onEvent({ kind: 'tool_use', id: String(item.id), name: 'apply_patch', input: item.changes });
          else if (item?.type === 'mcp_tool_call')
            onEvent({ kind: 'tool_result', id: String(item.id), output: clip(JSON.stringify(item.result ?? item.error ?? '')), is_error: !!item.error });
          // Codex reports missing model metadata as an "error" item; it carries on, so it is a note, not a failure.
          else if (item?.type === 'error') onEvent({ kind: 'stderr', text: String(item.message) });
          break;
        case 'turn.completed': {
          const u = m.usage as Record<string, number> | undefined;
          if (u)
            onEvent({
              kind: 'usage',
              id: `turn-${++usageCount}`,
              input: Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0)),
              output: u.output_tokens ?? 0,
              cache_read: u.cached_input_tokens ?? 0,
              cache_write: u.cache_write_input_tokens ?? 0,
            });
          break;
        }
        case 'error':
          // Codex reports retries ("reconnecting…") this way and carries on; turn.failed is the end.
          onEvent({ kind: 'stderr', text: String(m.message ?? 'Codex error') });
          break;
        case 'turn.failed': {
          gotResult = true;
          const err = (m.error as { message?: string } | undefined)?.message ?? String(m.message ?? 'Codex failed');
          onEvent({ kind: 'result', ok: false, error: err });
          break;
        }
      }
    });
    createInterface({ input: child.stderr }).on('line', (text) => {
      // Codex says it reads the prompt from stdin, and warns about helper links; neither matters to the job.
      if (text.trim() && !/^Reading (additional )?(input|prompt) from stdin|could not create PATH aliases/.test(text)) onEvent({ kind: 'stderr', text });
    });

    const done = new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        onEvent({ kind: 'result', ok: false, error: `could not start ${run.command}: ${err.message}` });
        resolve(null);
      });
      child.on('close', (code) => {
        if (!gotResult) {
          if (code === 0) onEvent({ kind: 'result', ok: true, summary: lastMessage || undefined });
          else if (code !== null) onEvent({ kind: 'result', ok: false, error: `Codex exited with code ${code}` });
        }
        resolve(code);
      });
    });
    return { pid: child.pid, done, kill: () => killTree(child.pid) };
  },
};
