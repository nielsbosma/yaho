import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { getMessage, sendMessage } from '../store.ts';
import { TelegramBridge, type TelegramApi } from './bridge.ts';
import { chunks, keyboard, messageParts, parseAction, toTelegram } from './format.ts';

describe('toTelegram', () => {
  it('converts the Markdown agents write to Telegram HTML', () => {
    expect(toTelegram('# Report\n**Signups** up, *slightly*. See [the board](https://x.io/b?a=1&b=2).\n- one\n- two')).toBe(
      '<b>Report</b>\n<b>Signups</b> up, <i>slightly</i>. See <a href="https://x.io/b?a=1&amp;b=2">the board</a>.\n• one\n• two',
    );
    expect(toTelegram('```copy Note for Anna\nHej <Anna>!\n```')).toBe('<b>Note for Anna</b>\n<pre>Hej &lt;Anna&gt;!</pre>');
    expect(toTelegram('a < b & `x < y` and snake_case_name')).toBe('a &lt; b &amp; <code>x &lt; y</code> and snake_case_name');
  });

  it('keeps tags balanced when a long text is cut', () => {
    const parts = chunks(`<pre>${'line\n'.repeat(1000)}</pre>`, 1000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.split('<pre>').length).toBe(p.split('</pre>').length);
  });
});

describe('keyboard', () => {
  const base = { id: 'msg_1', from: 'agent:a', to: 'human', title: 'T', body: 'B', reply_to: null, hop: 0, job: null, created: '' };
  const data = (k: ReturnType<typeof keyboard>) => k.flat().map((b) => b.callback_data);

  it('has choices or Done while waiting, Mark Read while unread, and nothing once answered', () => {
    expect(data(keyboard({ ...base, type: 'question', read: false, expects_response: true, choices: ['Yes', 'No'] }, false))).toEqual([
      'c:msg_1:0',
      'c:msg_1:1',
      'r:msg_1',
    ]);
    expect(data(keyboard({ ...base, type: 'instruction', read: false, expects_response: true }, false))).toEqual(['d:msg_1', 'r:msg_1']);
    expect(data(keyboard({ ...base, type: 'instruction', read: true, expects_response: true }, true))).toEqual([]);
    expect(parseAction('c:msg_1:1')).toEqual({ kind: 'choice', message: 'msg_1', index: 1 });
    expect(messageParts({ ...base, type: 'question', read: true, expects_response: true }, { answer: 'Yes' }).at(-1)!.text).toContain(
      'Answered: Yes',
    );
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

/** A fake Bot API: records calls; getUpdates waits a little and returns nothing (the tests deliver updates directly). */
function fakeTelegram() {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  let n = 100;
  const api: TelegramApi = {
    call: async <T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) => {
      if (method === 'getUpdates') {
        await new Promise((r) => {
          const t = setTimeout(r, 30);
          signal?.addEventListener('abort', () => (clearTimeout(t), r(undefined)));
        });
        return [] as T;
      }
      calls.push({ method, params: params as Record<string, any> });
      if (method === 'getMe') return { username: 'yaho_test_bot' } as T;
      if (method === 'sendMessage') return { message_id: ++n } as T;
      return true as T;
    },
  };
  return { api, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const OWNER = 4242;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-telegram-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO agents (name, created, updated) VALUES ('scout', ?, ?)").run(now, now);
});
afterAll(async () => {
  ctx.telegram?.stop();
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('TelegramBridge', () => {
  let tg: ReturnType<typeof fakeTelegram>;
  let bridge: TelegramBridge;
  const sent = () => tg.calls.filter((c) => c.method === 'sendMessage');
  const msg = (text: string, extra: Record<string, unknown> = {}, chat = OWNER) => ({
    update_id: 1,
    message: { chat: { id: chat, type: 'private' }, text, ...extra },
  });

  beforeEach(async () => {
    bridge?.stop();
    tg = fakeTelegram();
    ctx.settings.telegram = { bot_token: '123:abc' };
    bridge = new TelegramBridge(ctx, () => tg.api);
    bridge.pollTimeout = 0;
    ctx.telegram = bridge;
    await bridge.start();
  });

  it('links with the start code, posts the inbox, and takes answers back', async () => {
    expect(bridge.status).toMatchObject({ configured: true, connected: true, bot: 'yaho_test_bot', linked: false });
    const code = ctx.settings.telegram!.link_code!;
    expect(bridge.linkUrl()).toBe(`https://t.me/yaho_test_bot?start=${code}`);

    // Someone without the code is turned away; the code links the chat.
    await bridge.update(msg('/start', {}, 999));
    await bridge.update(msg('/start wrong', {}, 999));
    expect(ctx.settings.telegram?.owner).toBeUndefined();
    await bridge.update(msg(`/start ${code}`));
    expect(ctx.settings.telegram).toMatchObject({ owner: String(OWNER), link_code: undefined });
    expect(sent().at(-1)!.params.text).toContain('Yaho is connected.');

    // A question is posted with its choices as buttons; tapping one answers it and the message shows the outcome.
    const q = sendMessage(ctx, {
      from: 'agent:scout',
      to: 'human',
      type: 'question',
      title: 'Spend $5?',
      body: 'For **ads**',
      choices: ['Yes', 'No'],
    });
    await tick();
    const posted = sent().at(-1)!.params;
    expect(posted.text).toContain('<b>scout</b> via Yaho');
    expect(posted.text).toContain('For <b>ads</b>');
    const buttons = posted.reply_markup.inline_keyboard.flat();
    await bridge.update({
      update_id: 2,
      callback_query: { id: 'cb1', from: { id: OWNER }, message: { chat: { id: OWNER } }, data: buttons[0].callback_data },
    });
    await tick();
    const answer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(q.id) as { body: string };
    expect(answer.body).toBe('Yes');
    expect(getMessage(ctx, q.id).read).toBe(true);
    const edit = tg.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params;
    expect(edit.text).toContain('Answered: Yes');
    expect(edit.reply_markup.inline_keyboard).toEqual([]);

    // A reply to an instruction answers it in the person's own words; an answer in the app updates Telegram too.
    const ins = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'instruction', title: 'Add the DNS record' });
    await tick();
    const insId = 100 + sent().length;
    await bridge.update(msg('Done, took a minute', { reply_to_message: { message_id: insId } }));
    const insAnswer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(ins.id) as {
      body: string;
    };
    expect(insAnswer.body).toBe('Done, took a minute');

    const other = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'instruction', title: 'Sign the form' });
    await tick();
    sendMessage(ctx, { from: 'human', to: 'agent:scout', type: 'reply', body: 'Signed', reply_to: other.id });
    await tick();
    expect(tg.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text).toContain('Answered: Signed');

    // A ✅ reaction on an info message marks it read.
    const info = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'Weekly report' });
    await tick();
    await bridge.update({
      update_id: 3,
      message_reaction: { chat: { id: OWNER }, message_id: 100 + sent().length, new_reaction: [{ type: 'emoji', emoji: '👍' }] },
    });
    expect(getMessage(ctx, info.id).read).toBe(true);
  });

  it('only lets the owner act, and answers commands', async () => {
    ctx.settings.telegram = { ...ctx.settings.telegram!, owner: String(OWNER), since: new Date().toISOString(), post: 'expects_response' };
    const before = sent().length;
    sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'FYI' });
    const q = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'question', title: 'Go?' });
    await tick();
    expect(sent().length).toBe(before + 1);

    await bridge.update({ update_id: 4, callback_query: { id: 'cb2', from: { id: 7 }, message: { chat: { id: 7 } }, data: `d:${q.id}` } });
    expect(getMessage(ctx, q.id).read).toBe(false);
    expect(tg.calls.at(-1)).toMatchObject({
      method: 'answerCallbackQuery',
      params: { text: 'Only the person who connected Yaho can use it.' },
    });

    await bridge.update(msg('/inbox'));
    expect(sent().at(-1)!.params.text).toContain('Go?');
  });
});
