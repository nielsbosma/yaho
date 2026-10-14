import { randomBytes } from 'node:crypto';
import { chat } from '../assistant/index.ts';
import type { Ctx } from '../context.ts';
import { InboxMirror, eq, errorText, inboxCommand } from '../mirror/index.ts';
import type { Message } from '../store.ts';
import * as s from '../store.ts';
import { chunks, escapeHtml, messageParts, parseAction, toTelegram, type Action, type Keyboard } from './format.ts';

type Row = Record<string, unknown>;

const CHECKS = ['✅', '✔', '☑', '👍', '👌'];
/** Calls other than long polling give up after this long. */
const CALL_TIMEOUT_MS = 30_000;
/** Polling waits this long after an error, doubling up to MAX_BACKOFF_MS while errors go on. */
const BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export class TelegramError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** One Bot API call; the real API over fetch, or a fake in tests. */
export interface TelegramApi {
  call<T = unknown>(method: string, params?: Row, signal?: AbortSignal): Promise<T>;
}

export interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  /** The bot's @username. */
  bot?: string;
  /** Whether the person has opened the bot's link, so Yaho knows their chat. */
  linked: boolean;
  error?: string;
}

type TelegramSettings = NonNullable<Ctx['settings']['telegram']>;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Mirrors the human's inbox into a chat with their own Telegram bot and takes answers back, like the Slack and WhatsApp
 * bridges. Updates come by long polling, so no webhook is needed. Buttons, replies to a message and ✅ reactions become
 * replies, Done and Mark Read through the same store functions the app uses; an answer given in the app updates the
 * Telegram message. Only the chat that opened the bot's one-time link can act.
 */
export class TelegramBridge extends InboxMirror<TelegramStatus, TelegramSettings> {
  protected readonly chat = chat;
  protected readonly key = 'telegram';
  protected readonly table = 'telegram_posts';
  api: TelegramApi | null = null;
  status: TelegramStatus = { configured: false, connected: false, linked: false };
  private abort: AbortController | null = null;
  private offset: number | undefined;
  connect: (token: string) => TelegramApi;
  /** Long polling's wait in seconds; tests use 0. */
  pollTimeout = 25;

  constructor(ctx: Ctx, connect?: (token: string) => TelegramApi) {
    super(ctx);
    this.connect = connect ?? realApi;
  }

  protected derived(): Partial<TelegramStatus> {
    return { linked: !!this.settings.owner };
  }

  /** The code in the bot's start link; whoever opens the link with it becomes the owner. Made once until used. */
  linkCode(): string {
    if (!this.settings.link_code) this.save({ link_code: randomBytes(12).toString('hex') });
    return this.settings.link_code!;
  }

  /** The link that opens the bot in Telegram with the link code. */
  linkUrl(): string | undefined {
    return this.status.bot ? `https://t.me/${this.status.bot}?start=${this.linkCode()}` : undefined;
  }

  async start(): Promise<void> {
    const live = this.begin();
    this.close();
    const token = this.settings.bot_token;
    if (!token) return this.setStatus({ configured: false, connected: false, error: undefined, bot: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined });
    try {
      const api = this.connect(token);
      const me = await api.call<{ username?: string }>('getMe');
      if (!live()) return;
      // getUpdates refuses to work while a webhook is set.
      await api.call('deleteWebhook');
      if (!live()) return;
      this.api = api;
      if (me.username && me.username !== this.settings.bot) this.save({ bot: me.username });
      this.listen();
      this.setStatus({ connected: true, bot: me.username });
      if (!this.settings.owner) this.linkCode();
      const abort = (this.abort = new AbortController());
      void this.poll(api, abort.signal, live);
      await this.catchUp(live);
    } catch (err) {
      if (live()) this.fail(err);
    }
  }

  stop(): void {
    this.begin();
    this.close();
  }

  private close(): void {
    this.abort?.abort();
    this.abort = null;
    this.api = null;
    if (this.status.connected) this.setStatus({ connected: false });
  }

  private async poll(api: TelegramApi, signal: AbortSignal, live: () => boolean): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      try {
        const updates = await api.call<Row[]>(
          'getUpdates',
          { offset: this.offset, timeout: this.pollTimeout, allowed_updates: ['message', 'callback_query', 'message_reaction'] },
          AbortSignal.any([signal, AbortSignal.timeout((this.pollTimeout + 30) * 1000)]),
        );
        if (signal.aborted) return;
        backoff = 0;
        if (this.status.error) this.setStatus({ error: undefined, connected: true });
        for (const u of updates) {
          this.offset = Number(u.update_id) + 1;
          await this.update(u).catch((err) => this.fail(err));
          if (signal.aborted) return;
        }
        if (!updates.length && this.pollTimeout === 0) await sleep(20, signal);
      } catch (err) {
        if (signal.aborted) return;
        // A revoked or wrong token stays wrong: stop until the settings change.
        if (err instanceof TelegramError && err.code === 401) {
          console.error(`[telegram] the bot token was refused (${err.message}); polling stopped`);
          if (live()) {
            this.api = null;
            this.setStatus({ connected: false, error: 'Telegram refused the bot token; paste a new one from BotFather' });
          }
          return;
        }
        backoff = Math.min(backoff ? backoff * 2 : BACKOFF_MS, MAX_BACKOFF_MS);
        const why = errorText(err);
        if (why !== this.status.error) {
          console.error(`[telegram] polling: ${why}; retrying with backoff`);
          this.setStatus({ error: why });
        }
        await sleep(backoff, signal);
      }
    }
  }

  // ---------- out: the inbox into Telegram ----------

  private postsFor(id: string): Array<{ chat: string; tg_id: number; actions: number }> {
    return this.ctx.db
      .prepare('SELECT chat, tg_id, actions FROM telegram_posts WHERE message = ? ORDER BY created, tg_id')
      .all(id) as never;
  }

  private messageAt(chat: string, tgId: number): string | undefined {
    const r = this.ctx.db.prepare('SELECT message FROM telegram_posts WHERE chat = ? AND tg_id = ?').get(chat, tgId) as Row | undefined;
    return r ? (r.message as string) : undefined;
  }

  private async send(text: string, keyboard: Keyboard = [], extra: Row = {}): Promise<number | null> {
    const owner = this.settings.owner;
    if (!this.api || !owner) return null;
    const r = await this.api.call<{ message_id: number }>('sendMessage', {
      chat_id: owner,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      ...extra,
    });
    return r.message_id;
  }

  private async text(body: string): Promise<void> {
    for (const c of chunks(body)) await this.send(c);
  }

  async onMessage(m: Message & { deleted?: boolean }): Promise<void> {
    if (!this.api) return;
    if (m.deleted) {
      for (const p of this.postsFor(m.id))
        await this.api.call('deleteMessage', { chat_id: p.chat, message_id: p.tg_id }).catch(() => undefined);
      this.ctx.db.prepare('DELETE FROM telegram_posts WHERE message = ?').run(m.id);
      return;
    }
    // An answer from the human, in the app or in Telegram: the message it answers shows the outcome.
    if (m.from === 'human' && m.reply_to) return this.refresh(m.reply_to);
    if (!this.wanted(m)) return;
    if (this.postsFor(m.id).length) return this.refresh(m.id);
    await this.post(s.getMessage(this.ctx, m.id));
  }

  async post(m: Message): Promise<void> {
    if (!this.api || !this.settings.owner) return;
    const parts = messageParts(m, { answer: this.answerOf(m.id) });
    for (const [i, part] of parts.entries()) {
      const id = await this.send(part.text, part.keyboard);
      if (id === null) return;
      this.ctx.db
        .prepare('INSERT OR REPLACE INTO telegram_posts (chat, tg_id, message, actions, created) VALUES (?, ?, ?, ?, ?)')
        .run(this.settings.owner, id, m.id, i === parts.length - 1 ? 1 : 0, new Date().toISOString());
    }
    this.shownNow(m.id);
  }

  /** Telegram lets a bot edit what it sent: the last piece shows the outcome, and its buttons go once nothing waits. */
  async refresh(id: string): Promise<void> {
    const post = this.postsFor(id).find((p) => p.actions);
    if (!post || !this.api) return;
    let m: Message;
    try {
      m = s.getMessage(this.ctx, id);
    } catch {
      return;
    }
    const part = messageParts(m, { answer: this.answerOf(id) }).at(-1)!;
    await this.api
      .call('editMessageText', {
        chat_id: post.chat,
        message_id: post.tg_id,
        text: part.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: part.keyboard },
      })
      .catch((err) => {
        if (!/not modified/i.test(errorText(err))) throw err;
      });
    this.shownNow(id);
  }

  /** On connect: post what arrived since the last catch-up, and update posts answered or read meanwhile. */
  async catchUp(live: () => boolean = () => true): Promise<void> {
    if (!this.settings.owner || !this.settings.since) return;
    await this.postNew(live);
    await this.refreshRecent(live);
  }

  // ---------- in: Telegram into Yaho ----------

  async update(u: Row): Promise<void> {
    if (process.env.YAHO_DEBUG === '1')
      console.error(
        `[telegram] ${Object.keys(u)
          .filter((k) => k !== 'update_id')
          .join(',')}`,
      );
    if (u.callback_query) return this.callback(u.callback_query as Row);
    if (u.message_reaction) return this.reaction(u.message_reaction as Row);
    if (u.message) return this.message(u.message as Row);
  }

  private isOwner(chat: Row | undefined): boolean {
    return !!this.settings.owner && String(chat?.id) === this.settings.owner;
  }

  private async message(msg: Row): Promise<void> {
    const chatRow = msg.chat as Row | undefined;
    if (chatRow?.type !== 'private' || !this.api) return;
    const text = String(msg.text ?? '').trim();
    if (!this.isOwner(chatRow)) {
      const code = /^\/start(?:@\S+)?\s+(\S+)/.exec(text)?.[1];
      const want = this.settings.link_code;
      if (!this.settings.owner && code && want && eq(code, want)) return this.link(String(chatRow.id));
      await this.api.call('sendMessage', { chat_id: chatRow.id, text: 'This Yaho bot belongs to someone else.' }).catch(() => undefined);
      return;
    }
    if (!text) return this.text('Yaho reads text messages only.');
    const quoted = (msg.reply_to_message as Row | undefined)?.message_id as number | undefined;
    const id = quoted !== undefined ? this.messageAt(String(chatRow.id), quoted) : undefined;
    if (id) return this.reply(id, text);
    if (text.startsWith('/')) return this.text(this.command(text.slice(1)));
    // Chat runs in the background, so polling (and the buttons) go on while Yaho thinks.
    void this.ask(text).catch((err) => this.fail(err));
  }

  /** Opening the bot's link with the code links Telegram: from then on the person's inbox is posted to this chat. */
  private async link(chat: string): Promise<void> {
    this.save({ owner: chat, since: new Date().toISOString(), link_code: undefined });
    this.forgetChats();
    this.setStatus({});
    const unread = s.unreadCount(this.ctx);
    const body =
      '<b>Yaho is connected.</b> New messages from your agents arrive here. Answer with the buttons, or reply to a message. Send /help for commands.';
    await this.send(body, unread ? [[{ text: `Post ${unread} Unread`, callback_data: 'b:' }]] : []);
  }

  private async callback(q: Row): Promise<void> {
    if (!this.api) return;
    const msg = q.message as Row | undefined;
    const from = q.from as Row | undefined;
    const answer = (text?: string) =>
      this.api?.call('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => undefined);
    if (!this.isOwner((msg?.chat as Row | undefined) ?? { id: from?.id }))
      return void (await answer('Only the person who connected Yaho can use it.'));
    const action = parseAction(String(q.data ?? ''));
    await answer(action ? await this.act(action) : undefined);
  }

  /** Does what a button says; returns a short note for the tap's toast, if any. */
  private async act(a: Action): Promise<string | undefined> {
    if (a.kind === 'backlog') {
      const n = await this.postBacklog();
      return n ? undefined : 'Nothing unread.';
    }
    const note = this.tap(a.message, a.kind, a.kind === 'choice' ? a.index : -1);
    if (note) await this.refresh(a.message);
    return note;
  }

  private async reaction(r: Row): Promise<void> {
    if (!this.isOwner(r.chat as Row)) return;
    const emojis = ((r.new_reaction as Row[] | undefined) ?? []).map((x) => String(x.emoji ?? ''));
    if (!emojis.some((e) => CHECKS.some((c) => e.startsWith(c)))) return;
    const id = this.messageAt(String((r.chat as Row).id), Number(r.message_id));
    if (id) s.markRead(this.ctx, id, true);
  }

  /** /run <agent>, /send <agent> <text>, /inbox, /help. */
  command(line: string): string {
    const [head = 'help', ...rest] = line.trim().split(/\s+/);
    return (
      inboxCommand(this.ctx, head.replace(/@\S+$/, ''), rest, { via: 'Telegram', esc: escapeHtml, bold: (t) => `<b>${t}</b>` }) ??
      '/run &lt;agent&gt; · /send &lt;agent&gt; &lt;message&gt; · /inbox\nAnything else you write goes to Yaho’s chat. Reply to an agent’s message to answer it.'
    );
  }

  /** Text that is not a reply goes to Chat with Yaho; the conversation is kept briefly. */
  async ask(text: string): Promise<void> {
    const chat = this.settings.owner;
    if (!chat) return;
    await this.api?.call('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => undefined);
    try {
      await this.text(toTelegram(await this.converse(chat, text)));
    } catch (err) {
      await this.text(`That did not work: ${escapeHtml(errorText(err))}`);
    }
  }
}

/** The real Bot API over fetch. Calls without a signal of their own time out. */
function realApi(token: string): TelegramApi {
  return {
    call: async <T>(method: string, params: Row = {}, signal?: AbortSignal) => {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const body = (await r.json().catch(() => ({}))) as Row;
      if (!body.ok) throw new TelegramError(String(body.description ?? `HTTP ${r.status}`), (body.error_code as number | undefined) ?? r.status);
      return body.result as T;
    },
  };
}
