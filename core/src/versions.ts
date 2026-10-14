import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import type { Ctx } from './context.ts';
import { withoutCaps } from './harness/asAgent.ts';
import { agentExists, getAgent, HttpError, saveAgent } from './store.ts';

/**
 * Every agent's workspace and definition under git. The repository is the core's: its .git lives in the data folder,
 * outside the workspace, so an agent can neither read nor rewrite its own history. Only the core commits, on one
 * branch, so parallel jobs never need a merge: each commit is a snapshot of the folder at that moment.
 */

type Row = Record<string, unknown>;

/** Never versioned: transcripts, scratch, downloads, the agent's database (binary; its schema is), caches. */
const EXCLUDE = [
  '/.yaho/',
  '/work/',
  '/downloads/',
  '/agent.db',
  '/agent.db-*',
  '*.sqlite-wal',
  '*.sqlite-shm',
  '*.db-wal',
  '*.db-shm',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
];

/** Written by the core before each commit; edits to them by the agent are overwritten. */
export const DEFINITION_FILE = 'agent.yaml';
export const SCHEMA_FILE = 'agent.db.sql';
const DERIVED = new Set([DEFINITION_FILE, SCHEMA_FILE]);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PATCH_LIMIT = 400_000;

export interface Version {
  sha: string;
  date: string;
  author: string;
  subject: string;
  job: string | null;
  files: number;
}

export interface VersionDetail extends Version {
  body: string;
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; additions: number | null; deletions: number | null }>;
  patch: string;
  truncated: boolean;
}

class GitError extends Error {}

export function versionSettings(ctx: Ctx) {
  const v = ctx.settings.versions ?? {};
  return { enabled: v.enabled !== false, keep_days: v.keep_days ?? 90, max_file_mb: v.max_file_mb ?? 5 };
}

export class Versions {
  ctx: Ctx;
  /** null until checked; false when git is missing. */
  git: boolean | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    ctx.versions = this;
  }

  get on(): boolean {
    return versionSettings(this.ctx).enabled && this.git !== false;
  }

  dir(agent: string): string {
    return join(this.ctx.paths.root, 'versions', agent);
  }

  async start(): Promise<void> {
    this.git = await new Promise<boolean>((done) => execFile('git', ['--version'], (e) => done(!e)));
    if (!this.git) console.error('[yaho] git was not found: agent workspaces are not versioned');
    const daily = () => void this.pruneAll().catch((e) => console.error(`[yaho] pruning versions: ${(e as Error).message}`));
    daily();
    this.pruneTimer = setInterval(daily, 24 * 3600_000);
    this.pruneTimer.unref();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }

  /** One git operation at a time per agent. */
  private lock<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(agent) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(agent, settled);
    void settled.then(() => {
      if (this.locks.get(agent) === settled) this.locks.delete(agent);
    });
    return next;
  }

  /** Wait for an agent's pending git operations, e.g. before reading its history. */
  settle(agent: string): Promise<unknown> {
    return this.locks.get(agent) ?? Promise.resolve();
  }

  private run(
    agent: string,
    args: string[],
    opts: { input?: string; env?: Record<string, string>; ok?: number[] } = {},
  ): Promise<{ code: number; out: string }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Yaho',
      GIT_AUTHOR_EMAIL: 'yaho@localhost',
      GIT_COMMITTER_NAME: 'Yaho',
      GIT_COMMITTER_EMAIL: 'yaho@localhost',
      LC_ALL: 'C',
      ...opts.env,
    });
    const full = [
      '-c',
      'safe.directory=*',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      `--git-dir=${this.dir(agent)}`,
      `--work-tree=${this.ctx.paths.agent(agent)}`,
      ...args,
    ];
    const [cmd, argv] = withoutCaps('git', full);
    return new Promise((done, fail) => {
      const child = execFile(cmd, argv, { env, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (e, stdout, stderr) => {
        const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : -1) : 0;
        if (code === 0 || opts.ok?.includes(code)) return done({ code, out: stdout });
        fail(new GitError(`git ${args[0]}: ${(stderr || (e as Error).message).trim()}`));
      });
      if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
  }

  private async ensure(agent: string): Promise<void> {
    const dir = this.dir(agent);
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true });
      await this.run(agent, ['init', '-q', '--template=']);
      await this.run(agent, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      if (process.platform === 'win32') await this.run(agent, ['config', 'core.fileMode', 'false']);
    }
    mkdirSync(join(dir, 'info'), { recursive: true });
    writeFileSync(join(dir, 'info', 'exclude'), `${EXCLUDE.join('\n')}\n`);
  }

  private async head(agent: string): Promise<string | null> {
    const r = await this.run(agent, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { ok: [1, 128] });
    return r.code === 0 ? r.out.trim() : null;
  }

  /** The files the core keeps for the agent: its definition, and the schema of its own database. */
  private writeDerived(agent: string): void {
    if (!agentExists(this.ctx, agent)) return;
    const work = this.ctx.paths.agent(agent);
    const { name: _name, ...def } = getAgent(this.ctx, agent);
    writeFileSync(
      join(work, DEFINITION_FILE),
      `# ${agent}'s definition, written by Yaho for its history. Edits here change nothing: use the editor or yaho briefing update.\n${YAML.stringify(def)}`,
    );
    const db = join(work, 'agent.db');
    if (!existsSync(db)) return;
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        const rows = conn
          .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name")
          .all() as Row[];
        writeFileSync(
          join(work, SCHEMA_FILE),
          `-- The schema of agent.db, written by Yaho for its history.\n${rows.map((r) => `${r.sql as string};`).join('\n\n')}\n`,
        );
      } finally {
        conn.close();
      }
    } catch {
      // A database mid-write or not SQLite: keep the last schema.
    }
  }

  /**
   * Commit what changed in the workspace. paths: only these (a definition change while a job runs must not take the
   * job's half-done files with it). Returns the new commit, or null when nothing changed.
   */
  snapshot(
    agent: string,
    subject: string,
    opts: { paths?: string[]; author?: string; job?: string; body?: string } = {},
  ): Promise<string | null> {
    if (!this.on) return Promise.resolve(null);
    return this.lock(agent, () => this.commit(agent, subject, opts));
  }

  private async commit(agent: string, subject: string, opts: { paths?: string[]; author?: string; job?: string; body?: string }) {
    if (!existsSync(this.ctx.paths.agent(agent))) return null;
    await this.ensure(agent);
    this.writeDerived(agent);
    const scope = opts.paths ? ['--', ...opts.paths] : [];
    await this.run(agent, ['add', '-A', ...scope]);
    const skipped = await this.dropLarge(agent, scope);
    const staged = await this.run(agent, ['diff', '--cached', '--quiet', ...scope], { ok: [1] });
    if (staged.code === 0) return null;
    const lines = [subject.replace(/\s+/g, ' ').trim().slice(0, 120)];
    const body = [
      opts.body?.trim(),
      skipped.length ? `Not versioned (over ${versionSettings(this.ctx).max_file_mb} MB): ${skipped.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (body) lines.push('', body);
    if (opts.job) lines.push('', `Yaho-Job: ${opts.job}`);
    const author = opts.author ?? 'Yaho';
    await this.run(agent, ['commit', '-q', '--no-verify', '-F', '-', ...(opts.paths ? ['--only', ...scope] : [])], {
      input: `${lines.join('\n')}\n`,
      env: { GIT_AUTHOR_NAME: author },
    });
    await this.run(agent, ['gc', '--auto', '-q']).catch(() => undefined);
    return this.head(agent);
  }

  /** Files over the size limit stay out of the index (and out of history from then on). */
  private async dropLarge(agent: string, scope: string[]): Promise<string[]> {
    const limit = versionSettings(this.ctx).max_file_mb * 1024 * 1024;
    const r = await this.run(agent, ['diff', '--cached', '--name-only', '-z', '--diff-filter=AM', ...scope]);
    const work = this.ctx.paths.agent(agent);
    const big = r.out
      .split('\0')
      .filter(Boolean)
      .filter((p) => {
        try {
          return statSync(join(work, p)).size > limit;
        } catch {
          return false;
        }
      });
    if (big.length) await this.run(agent, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...big]);
    return big;
  }

  async log(agent: string, opts: { limit?: number; job?: string } = {}): Promise<Version[]> {
    if (!this.on || !existsSync(join(this.dir(agent), 'HEAD'))) return [];
    await this.settle(agent);
    return this.lock(agent, async () => {
      if (!(await this.head(agent))) return [];
      const args = [
        'log',
        `--max-count=${Math.min(opts.limit ?? 100, 1000)}`,
        '--no-renames',
        '--shortstat',
        `--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%(trailers:key=Yaho-Job,valueonly,separator=)`,
      ];
      if (opts.job) args.push(`--grep=^Yaho-Job: ${opts.job}$`);
      const r = await this.run(agent, args);
      return r.out
        .split('\x1e')
        .filter((c) => c.trim())
        .map((chunk) => {
          const [line = '', ...rest] = chunk.split('\n');
          const [sha = '', date = '', author = '', subject = '', job = ''] = line.split('\x1f');
          const files = Number(/(\d+) files? changed/.exec(rest.join(' '))?.[1] ?? 0);
          return { sha, date, author, subject, job: job.trim() || null, files };
        });
    });
  }

  async show(agent: string, sha: string): Promise<VersionDetail> {
    const commit = await this.resolve(agent, sha);
    return this.lock(agent, async () => {
      const meta = await this.run(agent, [
        'show',
        '-s',
        `--format=%H%x1f%aI%x1f%an%x1f%s%x1f%(trailers:key=Yaho-Job,valueonly,separator=)%x1f%b`,
        commit,
      ]);
      const [h = '', date = '', author = '', subject = '', job = '', body = ''] = meta.out.split('\x1f');
      const parent = await this.parentOf(agent, commit);
      const status = await this.run(agent, ['diff', '--no-renames', '--name-status', '-z', parent, commit]);
      const numstat = await this.run(agent, ['diff', '--no-renames', '--numstat', '-z', parent, commit]);
      const counts = new Map<string, [number | null, number | null]>();
      for (const rec of numstat.out.split('\0').filter(Boolean)) {
        const [a, d, ...p] = rec.split('\t');
        counts.set(p.join('\t'), [a === '-' ? null : Number(a), d === '-' ? null : Number(d)]);
      }
      const st = status.out.split('\0');
      const changes: VersionDetail['changes'] = [];
      for (let i = 0; i + 1 < st.length; i += 2) {
        const path = st[i + 1]!;
        const [additions, deletions] = counts.get(path) ?? [null, null];
        changes.push({ path, status: st[i] === 'A' ? 'added' : st[i] === 'D' ? 'deleted' : 'modified', additions, deletions });
      }
      const patch = (await this.run(agent, ['diff', '--no-renames', '--no-color', parent, commit])).out;
      const body2 = body.replace(/\n?Yaho-Job: .*\n?$/m, '').trim();
      return {
        sha: h,
        date,
        author,
        subject,
        job: job.trim() || null,
        files: changes.length,
        body: body2,
        changes,
        patch: patch.length > PATCH_LIMIT ? patch.slice(0, PATCH_LIMIT) : patch,
        truncated: patch.length > PATCH_LIMIT,
      };
    });
  }

  private async resolve(agent: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/.test(sha)) throw new HttpError(400, 'not a version');
    if (!this.on || !existsSync(join(this.dir(agent), 'HEAD'))) throw new HttpError(404, 'no versions');
    const r = await this.run(agent, ['rev-parse', '-q', '--verify', `${sha}^{commit}`], { ok: [1, 128] });
    if (r.code !== 0) throw new HttpError(404, `version ${sha} not found`);
    return r.out.trim();
  }

  private async parentOf(agent: string, commit: string): Promise<string> {
    const r = await this.run(agent, ['rev-parse', '-q', '--verify', `${commit}^`], { ok: [1, 128] });
    return r.code === 0 ? r.out.trim() : EMPTY_TREE;
  }

  /** The workspace's latest version. */
  current(agent: string): Promise<string | null> {
    if (!this.on || !existsSync(join(this.dir(agent), 'HEAD'))) return Promise.resolve(null);
    return this.lock(agent, () => this.head(agent));
  }

  /** Files a commit changed that other commits also changed between base (exclusive) and it. */
  async overlap(agent: string, base: string, commit: string): Promise<string[]> {
    return this.lock(agent, async () => {
      const parent = await this.parentOf(agent, commit);
      if (parent === base || parent === EMPTY_TREE) return [];
      const names = async (a: string, b: string) =>
        new Set((await this.run(agent, ['diff', '--no-renames', '--name-only', '-z', a, b])).out.split('\0').filter(Boolean));
      const mine = await names(parent, commit);
      const theirs = await names(base, parent);
      return [...mine].filter((p) => theirs.has(p) && !DERIVED.has(p));
    });
  }

  /** Put back the files one version changed (and the definition, if it did) as they were before it. */
  undo(agent: string, sha: string, author = 'human'): Promise<string | null> {
    return this.rewind(agent, sha, 'undo', author);
  }

  /** Put the whole workspace and definition back as they were at a version. */
  restore(agent: string, sha: string, author = 'human'): Promise<string | null> {
    return this.rewind(agent, sha, 'restore', author);
  }

  private async rewind(agent: string, sha: string, mode: 'undo' | 'restore', author: string): Promise<string | null> {
    if (this.ctx.db.prepare("SELECT 1 FROM jobs WHERE agent = ? AND status = 'running'").get(agent))
      throw new HttpError(409, `${agent} has a job running: stop it or wait for it to end first`);
    const commit = await this.resolve(agent, sha);
    return this.lock(agent, async () => {
      await this.commit(agent, 'Changes before going back', { author: 'Yaho' });
      const head = (await this.head(agent))!;
      const subject = (await this.run(agent, ['show', '-s', '--format=%s', commit])).out.trim();
      const [from, to] = mode === 'undo' ? [await this.parentOf(agent, commit), commit] : [commit, head];
      const diff = (await this.run(agent, ['diff', '--no-renames', '--name-status', '-z', from, to])).out.split('\0');
      const work = resolve(this.ctx.paths.agent(agent));
      const checkout: string[] = [];
      let definition = false;
      for (let i = 0; i + 1 < diff.length; i += 2) {
        const path = diff[i + 1]!;
        if (path === DEFINITION_FILE) definition = true;
        if (DERIVED.has(path)) continue;
        // In undo, "A" means the version added it; in restore, it was added since: either way it goes.
        if (diff[i] === 'A') {
          const file = resolve(work, path);
          if (file.startsWith(work + sep)) rmSync(file, { force: true });
        } else checkout.push(path);
      }
      for (let i = 0; i < checkout.length; i += 200) await this.run(agent, ['checkout', from, '--', ...checkout.slice(i, i + 200)]);
      if (definition && from !== EMPTY_TREE) {
        const old = await this.run(agent, ['show', `${from}:${DEFINITION_FILE}`], { ok: [128] });
        if (old.code === 0) {
          const def = YAML.parse(old.out) as Record<string, unknown>;
          saveAgent(this.ctx, { ...def, name: agent } as Parameters<typeof saveAgent>[1], { author: `${mode} (${author})` });
        }
      }
      return this.commit(agent, mode === 'undo' ? `Undid: ${subject}` : `Restored to: ${subject}`, {
        author,
        body: `${mode === 'undo' ? 'Undid' : 'Restored to'} ${commit.slice(0, 10)}.`,
      });
    });
  }

  async pruneAll(): Promise<void> {
    if (!this.on) return;
    for (const r of this.ctx.db.prepare('SELECT name FROM agents').all() as Row[]) await this.prune(r.name as string);
  }

  /**
   * Squash history older than keep_days into one first commit, then let git drop what nothing points at. Jobs that
   * pointed at a rewritten commit point at its copy; those that pointed at a squashed one lose their diff.
   */
  prune(agent: string, keepDays = versionSettings(this.ctx).keep_days): Promise<number> {
    if (!this.on || !existsSync(join(this.dir(agent), 'HEAD'))) return Promise.resolve(0);
    return this.lock(agent, async () => {
      const head = await this.head(agent);
      if (!head) return 0;
      const cutoff = Date.now() - keepDays * 864e5;
      const all = (await this.run(agent, ['rev-list', '--reverse', '--first-parent', '--format=%ct', head])).out
        .split('\n')
        .filter(Boolean)
        .reduce<Array<{ sha: string; at: number }>>((acc, line) => {
          if (line.startsWith('commit ')) acc.push({ sha: line.slice(7), at: 0 });
          else acc.at(-1)!.at = Number(line) * 1000;
          return acc;
        }, []);
      // Everything up to the last version older than the cutoff (clocks can step back, so not a filter).
      const last = all.findLastIndex((c) => c.at < cutoff);
      const old = all.slice(0, last + 1);
      if (old.length < 2) return 0;
      const base = old.at(-1)!;
      const map = new Map<string, string>();
      const date = new Date(base.at).toISOString().slice(0, 10);
      let parent = (
        await this.run(agent, ['commit-tree', `${base.sha}^{tree}`, '-F', '-'], {
          input: `Versions before ${date} (${old.length}) squashed\n`,
          env: { GIT_AUTHOR_DATE: `@${base.at / 1000}`, GIT_COMMITTER_DATE: `@${base.at / 1000}` },
        })
      ).out.trim();
      map.set(base.sha, parent);
      for (const c of all.slice(old.length)) {
        const info = (await this.run(agent, ['show', '-s', '--format=%an%x1f%ae%x1f%ad%x1f%cd%x1f%B', '--date=raw', c.sha])).out;
        const [an = '', ae = '', ad = '', cd = '', ...msg] = info.split('\x1f');
        parent = (
          await this.run(agent, ['commit-tree', `${c.sha}^{tree}`, '-p', parent, '-F', '-'], {
            input: msg.join('\x1f'),
            env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_DATE: cd },
          })
        ).out.trim();
        map.set(c.sha, parent);
      }
      await this.run(agent, ['update-ref', 'refs/heads/main', parent, head]);
      const { db } = this.ctx;
      db.exec('BEGIN');
      try {
        for (const col of ['commit_sha', 'base_sha'])
          for (const j of db.prepare(`SELECT id, ${col} c FROM jobs WHERE agent = ? AND ${col} IS NOT NULL`).all(agent) as Row[])
            db.prepare(`UPDATE jobs SET ${col} = ? WHERE id = ?`).run(map.get(j.c as string) ?? null, j.id as string);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      await this.run(agent, ['reflog', 'expire', '--expire=now', '--all']);
      await this.run(agent, ['gc', '--prune=now', '-q']);
      return old.length - 1;
    });
  }
}
