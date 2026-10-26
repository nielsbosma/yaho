import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context.ts';
import { indexJob } from './history.ts';
import { serve } from './serve.ts';
import { addArtifact, agentExists, deleteArtifacts, listJobs, listMessages, saveAgent, saveProject } from './store.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-store-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('the store', () => {
  it('renames an agent everywhere, or not at all', () => {
    saveAgent(ctx, { name: 'old' });
    saveProject(ctx, { name: 'p' });
    const t = new Date().toISOString();
    ctx.db
      .prepare("INSERT INTO jobs (id, agent, trigger_type, status, created, ended) VALUES ('j1','old','manual','finished',?,?)")
      .run(t, t);
    indexJob(ctx, 'j1');
    addArtifact(ctx, { project: 'p', agent: 'old', job: 'j1', kind: 'file', file_path: 'a.txt' });
    mkdirSync(join(ctx.paths.root, 'codex', 'old'), { recursive: true });

    expect(() => saveAgent(ctx, { name: 'new', triggers: [{ cron: 'not a cron' }] }, { rename: 'old' })).toThrow(/cron/);
    expect(agentExists(ctx, 'old')).toBe(true);

    saveAgent(ctx, { name: 'new' }, { rename: 'old' });
    expect(agentExists(ctx, 'old')).toBe(false);
    for (const table of ['jobs', 'artifacts', 'job_search'])
      expect(ctx.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE agent = 'old'`).get()).toEqual({ n: 0 });
    expect(ctx.db.prepare("SELECT agent FROM job_search WHERE job = 'j1'").get()).toEqual({ agent: 'new' });
    expect(existsSync(join(ctx.paths.root, 'codex', 'new'))).toBe(true);
    expect(existsSync(ctx.paths.agent('new'))).toBe(true);
  });

  it('filters jobs by status', () => {
    expect(listJobs(ctx, { status: 'finished' })).toHaveLength(1);
    expect(listJobs(ctx, { status: 'failed' })).toEqual([]);
  });

  it('takes the default for a limit that is not a number', () => {
    expect(listJobs(ctx, { limit: Number('abc') })).toHaveLength(1);
    expect(listMessages(ctx, { limit: Number('abc') })).toEqual([]);
  });

  it('removes only files inside the artifacts folder', () => {
    const sibling = join(ctx.paths.project('p'), 'artifacts-keep');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x'), 'keep');
    const a = addArtifact(ctx, { project: 'p', agent: 'new', job: null, kind: 'file', file_path: '../artifacts-keep/x' });
    expect(deleteArtifacts(ctx, [a.id as string])).toBe(1);
    expect(existsSync(join(sibling, 'x'))).toBe(true);
  });
});
