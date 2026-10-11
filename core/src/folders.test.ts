import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from './context.ts';
import { serve } from './serve.ts';
import { createFolder, deleteFolder, listAgents, listFolders, moveAgentToFolder, renameFolder } from './store.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-folders-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO agents (name, created, updated) VALUES ('a', ?, ?), ('b', ?, ?)").run(now, now, now, now);
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const folderOf = (name: string) => listAgents(ctx).find((a) => a.name === name)!.folder;

describe('agent folders', () => {
  it('creates, moves agents in and out, renames and deletes without losing agents', () => {
    expect(createFolder(ctx, ' Marketing ')).toEqual(['Marketing']);
    createFolder(ctx, 'Ops');
    expect(() => createFolder(ctx, 'Ops')).toThrow(/exists/);
    expect(listFolders(ctx)).toEqual(['Marketing', 'Ops']);

    expect(folderOf('a')).toBeNull();
    moveAgentToFolder(ctx, 'a', 'Marketing');
    expect(folderOf('a')).toBe('Marketing');
    expect(() => moveAgentToFolder(ctx, 'a', 'Nope')).toThrow(/not found/);

    renameFolder(ctx, 'Marketing', 'Growth');
    expect(folderOf('a')).toBe('Growth');

    deleteFolder(ctx, 'Growth');
    expect(listFolders(ctx)).toEqual(['Ops']);
    expect(folderOf('a')).toBeNull();
    expect(listAgents(ctx).map((x) => x.name)).toEqual(['a', 'b']);

    createFolder(ctx, 'Gone');
    moveAgentToFolder(ctx, 'b', 'Gone');
    deleteFolder(ctx, 'Gone', { agents: true });
    expect(listAgents(ctx).map((x) => x.name)).toEqual(['a']);
  });
});
