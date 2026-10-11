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

describe('message search', () => {
  it('filters by words, agent, direction, read state and date, and counts the total', async () => {
    const { searchMessages, sendMessage } = await import('./store.ts');
    sendMessage(ctx, { from: 'agent:a', to: 'human', type: 'info', title: 'Weekly report', body: 'Signups up 12% (100_000 visits)' });
    sendMessage(ctx, { from: 'human', to: 'agent:a', type: 'info', title: 'Thanks', body: 'Keep the report weekly' });
    sendMessage(ctx, { from: 'agent:a', to: 'human', type: 'question', title: 'Budget?', body: 'May I spend $5?' });

    expect(searchMessages(ctx, { text: 'report' }).total).toBe(2);
    expect(searchMessages(ctx, { text: 'weekly REPORT', direction: 'to_human' }).messages.map((m) => m.title)).toEqual(['Weekly report']);
    expect(searchMessages(ctx, { text: '100_000' }).total).toBe(1); // _ is literal, not a wildcard
    expect(searchMessages(ctx, { text: '12%' }).total).toBe(1);
    expect(searchMessages(ctx, { agent: 'a', type: 'question' }).total).toBe(1);
    expect(searchMessages(ctx, { direction: 'from_human' }).total).toBe(1);
    expect(searchMessages(ctx, { since: '2999-01-01' }).total).toBe(0);
    expect(searchMessages(ctx, { until: new Date().toISOString().slice(0, 10) }).total).toBe(3);
    expect(searchMessages(ctx, { limit: 1 })).toMatchObject({ total: 3 });
  });
});

describe('expects_response', () => {
  it('defaults to true for questions and instructions, false for info, and can be set either way', async () => {
    const { sendMessage } = await import('./store.ts');
    const send = (type: 'question' | 'instruction' | 'info', expects_response?: boolean) =>
      sendMessage(ctx, { from: 'agent:a', to: 'human', type, title: type, ...(expects_response === undefined ? {} : { expects_response }) })
        .expects_response;
    expect([send('question'), send('instruction'), send('info')]).toEqual([true, true, false]);
    expect([send('info', true), send('instruction', false)]).toEqual([true, false]);
  });
});

describe('choices', () => {
  it('are always text, even when an agent sends numbers', async () => {
    const { sendMessage, getMessage } = await import('./store.ts');
    const m = sendMessage(ctx, { from: 'agent:a', to: 'human', type: 'question', title: 'Pick', choices: [1, 2, 3] as unknown as string[] });
    expect(getMessage(ctx, m.id).choices).toEqual(['1', '2', '3']);
  });
});
