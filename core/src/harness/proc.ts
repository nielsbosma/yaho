import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How to ask this system when a process started, where it takes a program. */
function query(pid: number): [string, string[]] {
  return process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`]]
    : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
}

/** Linux: field 22 (starttime) of /proc/<pid>/stat. The command name in field 2 may hold spaces and parentheses. */
function linuxStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * When a process started, as a string that differs between two processes that had the same pid one after the other.
 * Null when the process is gone or this system cannot tell; its pid must then not be trusted.
 */
export function procStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxStart(pid);
  try {
    const r = spawnSync(...query(pid), { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** procStart without blocking, for recording a process just started. */
async function procStartAsync(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') return linuxStart(pid);
  try {
    const { stdout } = await run(...query(pid), { windowsHide: true, timeout: 15_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A process as recorded for later: its pid and when it started. */
export async function procId(pid: number | undefined): Promise<string | null> {
  if (!pid) return null;
  const start = await procStartAsync(pid);
  return start ? `${pid}:${start}` : null;
}

/** The pid of a recorded procId when that very process still runs; null otherwise. */
export function sameProc(id: string | null | undefined): number | null {
  const m = /^(\d+):(.+)$/.exec(id ?? '');
  if (!m) return null;
  const pid = Number(m[1]);
  return procStart(pid) === m[2] ? pid : null;
}
