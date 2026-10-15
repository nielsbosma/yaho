import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context.ts';
import { serve } from './serve.ts';
import { getAgent, saveAgent } from './store.ts';
import type { Versions } from './versions.ts';

let dir: string;
let ctx: Ctx;
let v: Versions;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-versions-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  v = ctx.versions!;
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const ws = (agent: string, path: string) => join(ctx.paths.agent(agent), path);
const put = (agent: string, path: string, text: string) => {
  mkdirSync(join(ws(agent, path), '..'), { recursive: true });
  writeFileSync(ws(agent, path), text);
};

describe('versions', () => {
  it('commits the workspace and the definition, but not scratch, transcripts or the database', async () => {
    saveAgent(ctx, { name: 'v1', briefing: 'first' });
    await v.settle('v1');
    put('v1', 'memory/MEMORY.md', '# notes\n');
    put('v1', 'work/tmp.txt', 'scratch');
    put('v1', '.yaho/ses.jsonl', '{}');
    const db = new DatabaseSync(ws('v1', 'agent.db'));
    db.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();

    const sha = await v.snapshot('v1', 'Job j1 finished', { job: 'j1', author: 'v1' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const detail = await v.show('v1', sha!);
    const paths = detail.changes.map((c) => c.path).sort();
    expect(paths).toEqual(['agent.db.sql', 'memory/MEMORY.md']);
    expect(readFileSync(ws('v1', 'agent.db.sql'), 'utf8')).toContain('CREATE TABLE contacts');
    expect(detail.job).toBe('j1');
    expect(await v.snapshot('v1', 'nothing')).toBeNull();

    const log = await v.log('v1');
    expect(log[0]).toMatchObject({ subject: 'Job j1 finished', job: 'j1', author: 'v1', files: 2 });
    expect(log.at(-1)!.subject).toBe('Created by human');
  });

  it('keeps a definition change to agent.yaml while a job has files half done', async () => {
    put('v1', 'memory/half.md', 'half done');
    saveAgent(ctx, { name: 'v1', briefing: 'second' }, { author: 'agent (j2)' });
    await v.settle('v1');
    const [last] = await v.log('v1', { limit: 1 });
    expect(last!.subject).toBe('Briefing changed by agent (j2)');
    expect((await v.show('v1', last!.sha)).changes.map((c) => c.path)).toEqual(['agent.yaml']);
    expect(await v.snapshot('v1', 'the rest')).not.toBeNull();
  });

  it('leaves out files over the size limit', async () => {
    ctx.settings.versions = { max_file_mb: 0.001 };
    put('v1', 'big.bin', 'x'.repeat(5000));
    const sha = await v.snapshot('v1', 'big');
    ctx.settings.versions = {};
    expect(sha).toBeNull();
  });

  it('undoes one version, and restores to an earlier one, definition included', async () => {
    saveAgent(ctx, { name: 'v2', briefing: 'one' });
    put('v2', 'memory/a.md', 'a1');
    const first = (await v.snapshot('v2', 'first'))!;
    put('v2', 'memory/a.md', 'a2');
    put('v2', 'memory/b.md', 'b');
    const second = (await v.snapshot('v2', 'second'))!;
    put('v2', 'scripts/run.sh', 'echo');
    saveAgent(ctx, { name: 'v2', briefing: 'two' });
    await v.settle('v2');
    await v.snapshot('v2', 'third');

    await v.undo('v2', second);
    expect(readFileSync(ws('v2', 'memory/a.md'), 'utf8')).toBe('a1');
    expect(existsSync(ws('v2', 'memory/b.md'))).toBe(false);
    expect(existsSync(ws('v2', 'scripts/run.sh'))).toBe(true);
    expect((await v.log('v2', { limit: 1 }))[0]!.subject).toBe('Undid: second');

    await v.restore('v2', first);
    await v.settle('v2');
    expect(existsSync(ws('v2', 'scripts/run.sh'))).toBe(false);
    expect(getAgent(ctx, 'v2').briefing).toBe('one');
  });

  it('refuses to go back while the agent has a job running', async () => {
    const [last] = await v.log('v2', { limit: 1 });
    const t = new Date().toISOString();
    ctx.db.prepare("INSERT INTO jobs (id, agent, trigger_type, status, created) VALUES ('jr','v2','manual','running',?)").run(t);
    await expect(v.undo('v2', last!.sha)).rejects.toThrow(/job running/);
    ctx.db.prepare("DELETE FROM jobs WHERE id = 'jr'").run();
  });

  it('names files another job changed while this one ran', async () => {
    saveAgent(ctx, { name: 'v3' });
    put('v3', 'memory/x.md', '0');
    const base = (await v.snapshot('v3', 'base'))!;
    put('v3', 'memory/x.md', 'other job');
    await v.snapshot('v3', 'other job');
    put('v3', 'memory/x.md', 'this job');
    put('v3', 'memory/y.md', 'this job');
    const mine = (await v.snapshot('v3', 'this job'))!;
    expect(await v.overlap('v3', base, mine)).toEqual(['memory/x.md']);
  });

  it('squashes history older than the limit and repoints jobs', async () => {
    saveAgent(ctx, { name: 'v4' });
    await v.settle('v4');
    const shas: string[] = [];
    const git = (...args: string[]) =>
      execFileSync('git', [`--git-dir=${v.dir('v4')}`, `--work-tree=${ctx.paths.agent('v4')}`, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
        },
      }).trim();
    for (const n of [1, 2, 3]) {
      put('v4', 'memory/n.md', String(n));
      git('add', '-A');
      git('commit', '-q', '-m', `old ${n}`);
      shas.push(git('rev-parse', 'HEAD'));
    }
    put('v4', 'memory/n.md', 'new');
    const recent = (await v.snapshot('v4', 'recent'))!;
    const t = new Date().toISOString();
    ctx.db
      .prepare(
        "INSERT INTO jobs (id, agent, trigger_type, status, created, commit_sha) VALUES ('jo','v4','manual','finished',?,?), ('jn','v4','manual','finished',?,?)",
      )
      .run(t, shas[0]!, t, recent);
    expect(await v.prune('v4', 30)).toBeGreaterThan(0);
    const log = await v.log('v4');
    expect(log.map((c) => c.subject)).toEqual(['recent', 'Versions before 2020-01-01 (4) squashed']);
    const jobs = ctx.db.prepare("SELECT id, commit_sha FROM jobs WHERE agent = 'v4' ORDER BY id").all() as Array<{
      id: string;
      commit_sha: string | null;
    }>;
    expect(jobs).toEqual([
      { id: 'jn', commit_sha: log[0]!.sha },
      { id: 'jo', commit_sha: null },
    ]);
    expect(readFileSync(ws('v4', 'memory/n.md'), 'utf8')).toBe('new');
  });

  it('moves the history with a renamed agent', async () => {
    saveAgent(ctx, { name: 'v5' }, { rename: 'v3' });
    await v.settle('v5');
    expect((await v.log('v5')).some((c) => c.subject === 'this job')).toBe(true);
  });
});
