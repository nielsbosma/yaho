import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { addProjectFile, copyToAgentWorkspace, listLocalFolder, readLocalFile, writeAgentFile } from './files.ts';

let dir: string;
let src: string;
let ctx: Ctx;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-files-'));
  ({ ctx, close } = await serve({ dataDir: join(dir, 'data'), port: 0, embedded: true }));
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO agents (name, created, updated) VALUES ('a', ?, ?)").run(now, now);
  src = join(dir, 'old');
  mkdirSync(join(src, 'lib', '__pycache__'), { recursive: true });
  writeFileSync(join(src, 'run.py'), 'print(1)');
  writeFileSync(join(src, 'lib', 'x.py'), 'x = 1');
  writeFileSync(join(src, 'lib', '__pycache__', 'x.pyc'), 'junk');
  writeFileSync(join(src, 'old.db'), 'db');
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('agent workspace files', () => {
  it('copies folders without caches, renames single files, writes files, and stays inside the workspace', async () => {
    expect(listLocalFolder(ctx, src).map((e) => e.name).sort()).toEqual(['lib', 'old.db', 'run.py']);
    const root = ctx.paths.agent('a');

    expect((await copyToAgentWorkspace(ctx, 'a', src, 'scripts')).files).toBe(3);
    expect(existsSync(join(root, 'scripts', 'lib', 'x.py'))).toBe(true);
    expect(existsSync(join(root, 'scripts', 'lib', '__pycache__'))).toBe(false);

    await copyToAgentWorkspace(ctx, 'a', join(src, 'old.db'), 'agent.db');
    expect(readFileSync(join(root, 'agent.db'), 'utf8')).toBe('db');

    expect(writeAgentFile(ctx, 'a', 'memory/notes.md', 'hi').path).toBe('memory/notes.md');
    expect(readFileSync(join(root, 'memory', 'notes.md'), 'utf8')).toBe('hi');

    expect(() => writeAgentFile(ctx, 'a', '../escape.txt', 'no')).toThrow(/bad path/);
    await expect(copyToAgentWorkspace(ctx, 'nobody', src)).rejects.toThrow(/not found/);
    // A folder into a folder inside itself would never end.
    await expect(copyToAgentWorkspace(ctx, 'a', root, 'scripts/again')).rejects.toThrow(/inside itself/);
  });

  it.skipIf(process.platform === 'win32')('never writes through a link the agent put in its workspace', async () => {
    const root = ctx.paths.agent('a');
    const outside = join(dir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precious'), 'keep');
    symlinkSync(join(outside, 'precious'), join(root, 'trap.txt'));
    symlinkSync(outside, join(root, 'trapdir'));
    expect(() => writeAgentFile(ctx, 'a', 'trap.txt', 'overwritten')).toThrow(/bad path/);
    expect(() => writeAgentFile(ctx, 'a', 'trapdir/new.txt', 'x')).toThrow(/bad path/);
    await expect(copyToAgentWorkspace(ctx, 'a', join(src, 'run.py'), 'trap.txt')).rejects.toThrow(/bad path/);
    await expect(copyToAgentWorkspace(ctx, 'a', src, 'trapdir')).rejects.toThrow(/bad path/);
    expect(readFileSync(join(outside, 'precious'), 'utf8')).toBe('keep');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it("refuses Yaho's own files, also through a link", async () => {
    await expect(readLocalFile(ctx, ctx.paths.token)).rejects.toThrow(/Yaho's own file/);
    if (process.platform === 'linux') expect(() => listLocalFolder(ctx, '/proc/self')).toThrow(/Yaho's own file/);
    if (process.platform !== 'win32') {
      const link = join(dir, 'innocent.txt');
      symlinkSync(ctx.paths.token, link);
      await expect(readLocalFile(ctx, link)).rejects.toThrow(/Yaho's own file/);
      ctx.db.prepare("INSERT INTO projects (name, title, created, updated) VALUES ('p', 'P', '', '')").run();
      expect(() => addProjectFile(ctx, 'p', link)).toThrow(/Yaho's own file/);
    }
    await expect(copyToAgentWorkspace(ctx, 'a', ctx.paths.root, 'stolen')).rejects.toThrow(/Yaho's own file|inside itself/);
  });

  it('keeps the chat to workspaces and projects in the server version', async () => {
    process.env.YAHO_SERVER = '1';
    try {
      await expect(readLocalFile(ctx, join(src, 'run.py'))).rejects.toThrow(/server version/);
      expect(() => listLocalFolder(ctx, src)).toThrow(/server version/);
      expect(listLocalFolder(ctx, ctx.paths.agent('a')).length).toBeGreaterThan(0);
    } finally {
      delete process.env.YAHO_SERVER;
    }
  });
});
