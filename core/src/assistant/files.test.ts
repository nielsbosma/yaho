import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { copyToAgentWorkspace, listLocalFolder, writeAgentFile } from './files.ts';

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
    expect(listLocalFolder(src).map((e) => e.name).sort()).toEqual(['lib', 'old.db', 'run.py']);
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
});
