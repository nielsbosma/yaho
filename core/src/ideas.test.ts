import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context.ts';
import { fileIdea, IDEAS_PER_DAY } from './ideas.ts';
import { serve } from './serve.ts';
import { listMessages } from './store.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
let job: (agent: string) => string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-ideas-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  job = (agent) => {
    const now = new Date().toISOString();
    ctx.db.prepare('INSERT OR IGNORE INTO agents (name, created, updated) VALUES (?, ?, ?)').run(agent, now, now);
    const id = `job_${Math.random().toString(36).slice(2)}`;
    ctx.db.prepare("INSERT INTO jobs (id, agent, trigger_type, status, created) VALUES (?, ?, 'manual', 'running', ?)").run(id, agent, now);
    return id;
  };
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('yaho idea', () => {
  it('files a new issue, skips a duplicate title, and limits each agent per day', async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify([{ title: 'Existing idea', url: 'https://github.com/x/y/issues/1' }]);
      return 'https://github.com/x/y/issues/2\n';
    };
    const who = { agent: 'idler', job: job('idler') };
    expect(await fileIdea(ctx, who, { title: 'New idea', body: 'Because.' }, gh)).toEqual({ filed: 'https://github.com/x/y/issues/2' });
    const create = calls.find((c) => c[1] === 'create')!;
    expect(create).toContain('nielsbosma/yaho');
    expect(create.at(-1)).toContain('Suggested by the Yaho agent `idler`');
    expect(await fileIdea(ctx, who, { title: 'existing idea', body: 'Again.' }, gh)).toEqual({ duplicate: 'https://github.com/x/y/issues/1' });
    for (let i = 2; i < IDEAS_PER_DAY; i++) await fileIdea(ctx, who, { title: `Idea ${i}`, body: 'More.' }, gh);
    await expect(fileIdea(ctx, who, { title: 'One too many', body: 'Stop.' }, gh)).rejects.toThrow(/in the last day/);
  });

  it('sends the idea to the human when gh fails', async () => {
    const who = { agent: 'offline', job: job('offline') };
    const r = await fileIdea(ctx, who, { title: 'Offline idea', body: 'No gh here.' }, async () => {
      throw new Error('spawn gh ENOENT');
    });
    expect(r).toMatchObject({ reason: 'spawn gh ENOENT' });
    const [m] = listMessages(ctx, { to: 'human' }).filter((x) => x.title === 'Idea for Yaho: Offline idea');
    expect(m?.steps?.[0]).toMatchObject({ open: expect.stringContaining('github.com/nielsbosma/yaho/issues/new?title=Offline%20idea') });
  });

  it('can be turned off', async () => {
    ctx.settings.ideas = { enabled: false };
    await expect(fileIdea(ctx, { agent: 'idler', job: job('idler') }, { title: 'T', body: 'B' })).rejects.toThrow(/turned off/);
    ctx.settings.ideas = undefined;
  });
});
