import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Ctx } from '../context.ts';

/**
 * The Dopbase that ships with YAHO: one local server per data directory, started and stopped by the core.
 * First start creates its root account non-interactively; the generated password stays next to Dopbase's own data
 * (the human manages values through YAHO, so nobody needs to type it). The core signs in over REST for a session.
 */
export const LOCAL_EMAIL = 'yaho@localhost.localdomain';
const exe = process.platform === 'win32' ? 'dopbase.exe' : 'dopbase';

export function findDopbaseBinary(): string | null {
  if (process.env.YAHO_DOPBASE_BIN) return existsSync(process.env.YAHO_DOPBASE_BIN) ? process.env.YAHO_DOPBASE_BIN : null;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../dopbase', exe), // packaged: resources/app/dopbase next to core/
    join(here, '../../../vendor/dopbase', exe), // repo: built by tools/build-dopbase.mjs
    ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, exe)),
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

interface Credentials {
  email: string;
  password: string;
}

export class LocalDopbase {
  ctx: Ctx;
  child: ChildProcess | null = null;
  token: string | null = null;
  bin: string | null;
  dataDir: string;
  url: string;
  lastError: string | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.bin = findDopbaseBinary();
    this.dataDir = join(ctx.paths.root, 'dopbase');
    this.url = `http://127.0.0.1:${process.env.YAHO_DOPBASE_PORT ?? ctx.settings.dopbase.local_port ?? 4702}`;
  }

  get credentialsFile(): string {
    return join(this.dataDir, 'yaho-root.yaml');
  }

  /** Create the root account on first use. Returns its credentials. */
  private setup(): Credentials {
    if (existsSync(this.credentialsFile)) return YAML.parse(readFileSync(this.credentialsFile, 'utf8')) as Credentials;
    mkdirSync(this.dataDir, { recursive: true });
    const r = spawnSync(this.bin!, ['--data-dir', this.dataDir, '--json', 'server', 'setup', '--email', LOCAL_EMAIL], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`dopbase setup failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    const out = JSON.parse(r.stdout) as { password: string; email: string };
    const creds = { email: out.email, password: out.password };
    writeFileSync(this.credentialsFile, YAML.stringify(creds), { mode: 0o600 });
    return creds;
  }

  async start(): Promise<void> {
    if (!this.bin) {
      this.lastError = 'no dopbase binary found (run node tools/build-dopbase.mjs, or set YAHO_DOPBASE_BIN)';
      return;
    }
    try {
      this.setup();
      this.killLeftover();
      const port = this.url.split(':').pop()!;
      this.child = spawn(this.bin, ['--data-dir', this.dataDir, 'server', 'start', '--host', '127.0.0.1', '--port', port], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (this.child.pid) writeFileSync(this.pidFile, String(this.child.pid));
      this.child.on('exit', (code) => {
        if (this.child && code !== null) this.lastError = `dopbase exited with code ${code}`;
        this.child = null;
      });
      for (let i = 0; i < 100; i++) {
        if (await this.healthy()) {
          this.lastError = null;
          return;
        }
        if (!this.child) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(this.lastError ?? 'dopbase did not start within 10 seconds');
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error(`[yaho] local Dopbase: ${this.lastError}`);
    }
  }

  async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/api/v1/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }

  /** A CLI session token, signing in again when asked to (`fresh`) or when there is none yet. */
  async sessionToken(fresh = false): Promise<string> {
    if (this.token && !fresh) return this.token;
    const creds = this.setup();
    const res = await fetch(`${this.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: creds.email, password: creds.password, sessionKind: 'cli' }),
    });
    const body = (await res.json()) as { data?: { token?: string } };
    if (!res.ok || !body.data?.token) throw new Error(`local Dopbase sign-in failed (${res.status})`);
    this.token = body.data.token;
    return this.token;
  }

  get pidFile(): string {
    return join(this.dataDir, 'yaho-dopbase.pid');
  }

  /** A Dopbase left running by a core that was killed outright holds the port and the database; stop it first. */
  private killLeftover(): void {
    if (!existsSync(this.pidFile)) return;
    const pid = Number(readFileSync(this.pidFile, 'utf8'));
    rmSync(this.pidFile, { force: true });
    if (!pid) return;
    if (process.platform === 'win32') {
      // Only if that pid is still a dopbase process; pids get reused.
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      if (/dopbase/i.test(r.stdout ?? '')) killPid(pid);
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    rmSync(this.pidFile, { force: true });
    if (c?.pid) killPid(c.pid);
  }
}

function killPid(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
