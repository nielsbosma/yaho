import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { paths, Settings } from '../config.ts';
import { serverMode } from '../api/session.ts';
import { resolveCommand } from './claudeCode.ts';
import { hookCommand } from './commandGuard.ts';

/** Sandbox mode, from Guard Rails: unset means on in the server version and off on the desktop. */
export const sandboxOn = (s: Settings): boolean => s.sandbox ?? serverMode();

/**
 * Why a harness cannot run sandboxed here, or null when it can. Claude Code's sandbox needs Seatbelt (macOS) or
 * bubblewrap and socat (Linux) and does not run on Windows; Codex brings its own sandbox for each platform.
 */
export function sandboxProblem(harness: string, env: Record<string, string | undefined> = process.env): string | null {
  if (harness !== 'claude-code') return null;
  if (process.platform === 'win32') return "Claude Code's sandbox runs on macOS and Linux, not on Windows";
  if (process.platform !== 'linux') return null;
  const missing = ['bwrap', 'socat'].filter((c) => {
    const p = resolveCommand(c, env);
    return !isAbsolute(p) || !existsSync(p);
  });
  return missing.length ? `Claude Code's sandbox needs ${missing.join(' and ')} (install bubblewrap and socat)` : null;
}

/** The hook script that keeps Claude Code's file tools in the workspace, next to the yaho shims in the bin folder. */
export const SANDBOX_GUARD = 'sandbox-guard.cjs';

/**
 * A PreToolUse hook for Write, Edit and NotebookEdit: a path outside the job's folder (or the temp folder) is refused
 * (exit 2), with the reason for the agent. Paths are compared after resolving links, so a link cannot lead out.
 */
export function sandboxGuardScript(): string {
  return `const p = require('node:path'), os = require('node:os'), fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  let j;
  try {
    j = JSON.parse(input || '{}');
  } catch {
    process.stderr.write('Sandbox Mode: could not read the tool call, so it was refused.');
    process.exit(2);
  }
  const t = j.tool_input || {};
  const file = t.file_path || t.notebook_path;
  if (!file) return;
  const real = (x) => {
    let dir = p.resolve(x), rest = '';
    for (;;) {
      try {
        return p.join(fs.realpathSync(dir), rest);
      } catch {
        const up = p.dirname(dir);
        if (up === dir) return p.resolve(x);
        rest = p.join(p.basename(dir), rest);
        dir = up;
      }
    }
  };
  const cwd = j.cwd || process.cwd();
  const target = real(p.resolve(cwd, file));
  const inside = [cwd, os.tmpdir()].map(real).some((root) => target === root || target.startsWith(root + p.sep));
  if (!inside) {
    process.stderr.write('Sandbox Mode: you may only write inside your workspace (' + cwd + ') and the temp folder.');
    process.exit(2);
  }
});
`;
}

/** The shell command that runs the guard, with the core's own Node (or Electron as Node). */
export const sandboxGuardCommand = (bin: string): string => hookCommand(bin, SANDBOX_GUARD);

/** The core's own files in the data folder, which no agent may read: the token, the database, settings, Dopbase. */
export const coreFiles = (p: ReturnType<typeof paths>): string[] => [
  p.token,
  p.db,
  `${p.db}-wal`,
  `${p.db}-shm`,
  `${p.db}-journal`,
  p.settings,
  p.server,
  p.totp,
  join(p.root, 'dopbase'),
  join(p.root, '.core'),
];

/** Sockets of services outside the sandbox (Docker, D-Bus, the desktop session's agents) that a command must not reach. */
function hostSockets(): string[] {
  const list = ['/var/run/docker.sock', '/run/docker.sock', '/run/containerd', '/run/podman', '/run/dbus', '/var/run/dbus', '/run/user'];
  if (process.env.SSH_AUTH_SOCK) list.push(dirname(process.env.SSH_AUTH_SOCK));
  return list.filter((x) => existsSync(x));
}

/**
 * Claude Code's settings for a sandboxed job: shell commands run in its sandbox (writes only in the workspace and the
 * temp folder, network open, none of denyRead readable), nothing may leave it, and the guard keeps the file tools in the
 * workspace too. Unix sockets: only the core's (yaho reaches it there) on macOS; on Linux the sandbox cannot tell
 * sockets apart by path, so those of other services are hidden instead.
 */
export function claudeSandboxSettings(guard: string, o: { socket?: string; denyRead?: string[] } = {}): Record<string, unknown> {
  const deny = o.denyRead ?? [];
  const sockets = process.platform === 'darwin' && o.socket ? { allowUnixSockets: [o.socket] } : { allowAllUnixSockets: true };
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['*'], ...sockets },
      filesystem: { denyRead: [...deny.filter((f) => existsSync(f)), ...(process.platform === 'linux' ? hostSockets() : [])] },
      // The server version runs in a container, which cannot mount a fresh /proc.
      ...(serverMode() ? { enableWeakerNestedSandbox: true } : {}),
    },
    // The file tools run outside the sandbox: the same files are off limits to them.
    ...(deny.length ? { permissions: { deny: deny.flatMap((f) => ['Read', 'Edit', 'Write'].map((t) => `${t}(/${f})`)) } } : {}),
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: guard }] }] },
  };
}
