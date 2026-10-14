import { join } from 'node:path';

/** The hook script that checks shell commands against Command Rules, next to the yaho shims in the bin folder. */
export const COMMAND_GUARD = 'command-guard.cjs';

/**
 * A PreToolUse hook for shell commands (Claude Code's Bash, Codex's shell): the core decides with the job's token, and
 * anything but allow is refused (exit 2) with the core's reason for the agent. A core it cannot reach refuses too.
 */
export function commandGuardScript(): string {
  return `const http = require('node:http');
let input = '';
const refuse = (why) => {
  process.stderr.write(why);
  process.exit(2);
};
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  let j;
  try {
    j = JSON.parse(input || '{}');
  } catch {
    return refuse('Command Rules: could not read the command.');
  }
  let c = (j.tool_input || {}).command;
  if (Array.isArray(c)) c = c.length >= 3 && /^-[a-z]*c$/.test(c[1]) ? c[2] : c.join(' ');
  if (typeof c !== 'string' || !c.trim()) return;
  const body = JSON.stringify({ command: c });
  const socket = process.env.YAHO_API_SOCKET;
  const url = new URL('/api/agent/guard/command', process.env.YAHO_API_URL || 'http://127.0.0.1');
  const req = http.request(
    {
      ...(socket ? { socketPath: socket } : { host: url.hostname, port: url.port }),
      path: url.pathname,
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.YAHO_JOB_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
    },
    (res) => {
      let out = '';
      res.on('data', (d) => (out += d)).on('end', () => {
        let r = {};
        try {
          r = JSON.parse(out);
        } catch {}
        if (res.statusCode === 200 && r.decision === 'allow') process.exit(0);
        refuse(r.reason || 'Command Rules: the check failed (' + (r.error || res.statusCode) + '), so the command was not run.');
      });
    },
  );
  req.on('error', (e) => refuse('Command Rules: could not reach Yaho to check the command (' + e.message + '), so it was not run.'));
  req.setTimeout(20000, () => req.destroy(new Error('timed out')));
  req.end(body);
});
`;
}

/** The shell command that runs a hook script from the bin folder, with the core's own Node (or Electron as Node). */
export function hookCommand(bin: string, script: string): string {
  const electron = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${electron}"${process.execPath}" "${join(bin, script)}"`;
}
