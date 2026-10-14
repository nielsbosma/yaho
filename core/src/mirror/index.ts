import { saveSettings } from '../config.ts';
import type { BusEvent, Ctx } from '../context.ts';
import type { ChatMessage } from '../assistant/index.ts';
import type { Message } from '../store.ts';
import * as s from '../store.ts';
import { errorText } from './util.ts';

type Row = Record<string, unknown>;

export { eq, errorText } from './util.ts';

/** Turns kept per chat with Yaho, and how many chats are remembered. */
const HISTORY_TURNS = 20;
const HISTORY_CHATS = 20;
/** Messages a catch-up looks at per query, and at most in all. */
const PAGE = 100;
const MAX_PAGES = 20;

/**
 * What a chat with Yaho keeps for its next turn: only the person's words and Yaho's plain text answers, starting with
 * the person's. Tool calls, tool results and images are left out, so a cut never leaves a tool result without its call.
 */
export function trimHistory(messages: ChatMessage[], max = HISTORY_TURNS): ChatMessage[] {
  const plain = messages.filter(
    (m) =>
      typeof m.content === 'string' &&
      m.content !== '' &&
      ((m.role === 'user' && !m.tool_call_id) || (m.role === 'assistant' && !m.tool_calls?.length)),
  );
  const last = plain.slice(-max);
  const first = last.findIndex((m) => m.role === 'user');
  return first < 0 ? [] : last.slice(first).map((m) => ({ role: m.role, content: m.content }));
}

/** The last plain text answer in a chat's messages. */
export function lastAnswer(messages: ChatMessage[]): string | undefined {
  return [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content as
    | string
    | undefined;
}

/** /run, /send and /inbox, shared by the chat bridges; undefined for anything else (the caller shows its help). */
export function inboxCommand(
  ctx: Ctx,
  verb: string,
  rest: string[],
  f: { via: string; esc?: (t: string) => string; bold?: (t: string) => string },
): string | undefined {
  const esc = f.esc ?? ((t: string) => t);
  const bold = f.bold ?? ((t: string) => `*${t}*`);
  try {
    if (verb === 'run' && rest[0]) {
      if (!s.agentExists(ctx, rest[0])) return `No agent named ${esc(rest[0])}.`;
      ctx.runner?.enqueue(rest[0], 'manual', { detail: `from ${f.via}`, force: true });
      return `Started ${esc(rest[0])}.`;
    }
    if (verb === 'send' && rest[0] && rest.length > 1) {
      s.sendMessage(ctx, { from: 'human', to: `agent:${rest[0]}`, type: 'info', body: rest.slice(1).join(' ') });
      return `Sent to ${esc(rest[0])}.`;
    }
    if (verb === 'inbox') {
      const unread = s.listMessages(ctx, { to: 'human', unread: true, limit: 20 });
      return unread.length
        ? unread.map((m) => `• ${bold(esc(m.from.replace(/^agent:/, '')))}: ${esc(m.title || m.body.slice(0, 80))}`).join('\n')
        : 'Your inbox is all read.';
    }
  } catch (err) {
    return `That did not work: ${esc(errorText(err))}`;
  }
  return undefined;
}

export interface MirrorStatus {
  configured: boolean;
  connected: boolean;
  error?: string;
}

export interface MirrorSettings {
  since?: string;
  post?: 'all' | 'expects_response';
}

/**
 * What the Slack, Telegram and WhatsApp bridges share: settings and status, the listener on the inbox, the
 * human's answers, catch-up after a reconnect, and the chat with Yaho. Each start() calls begin() first and checks the
 * returned live() after every await, so overlapping starts (a double-click on Reconnect) leave one connection.
 */
export abstract class InboxMirror<St extends MirrorStatus, Se extends MirrorSettings> {
  ctx: Ctx;
  abstract status: St;
  /** The settings section, the status entity and the log prefix. */
  protected abstract readonly key: 'slack' | 'telegram' | 'whatsapp';
  /** The table recording what each inbox message was posted as (its message column is message). */
  protected abstract readonly table: 'slack_posts' | 'telegram_posts' | 'whatsapp_posts';
  private generation = 0;
  private chats = new Map<string, ChatMessage[]>();
  /** What each post last showed (read, answered), so a catch-up only edits posts whose message changed. */
  private shown = new Map<string, string>();
  private listener = (e: BusEvent) => {
    if (e.type === 'message') void this.onMessage(e.message as Message & { deleted?: boolean }).catch((err) => this.fail(err));
  };

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  get settings(): Se {
    return ((this.ctx.settings as unknown as Row)[this.key] ?? {}) as Se;
  }

  protected save(patch: Partial<Se>): void {
    (this.ctx.settings as unknown as Row)[this.key] = { ...this.settings, ...patch };
    saveSettings(this.ctx.settings);
  }

  /** Status fields that follow from the settings (owner, linked…). */
  protected derived(): Partial<St> {
    return {};
  }

  protected setStatus(next: Partial<St>): void {
    this.status = { ...this.status, ...next, ...this.derived() };
    this.ctx.bus.emitEvent({ type: 'changed', entity: this.key });
  }

  fail(err: unknown): void {
    console.error(`[${this.key}] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    this.setStatus({ error: errorText(err) } as Partial<St>);
  }

  /** Ends whatever an earlier start set up and returns a check that stays true until the next start or stop. */
  protected begin(): () => boolean {
    const g = ++this.generation;
    this.ctx.bus.off('event', this.listener);
    return () => g === this.generation;
  }

  protected listen(): void {
    this.ctx.bus.off('event', this.listener);
    this.ctx.bus.on('event', this.listener);
  }

  abstract onMessage(m: Message & { deleted?: boolean }): Promise<void>;
  abstract post(m: Message): Promise<void>;
  abstract refresh(id: string): Promise<void>;

  /** The human's answer to a message, when there is one. */
  answerOf(id: string): string | undefined {
    const r = this.ctx.db
      .prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human' ORDER BY created DESC LIMIT 1")
      .get(id) as Row | undefined;
    return r ? String(r.body) : undefined;
  }

  /** Whether a message to the human is mirrored: all of them, or only those that wait for an answer. */
  protected wanted(m: Message): boolean {
    if (m.to !== 'human' || m.from === 'human') return false;
    return this.settings.post !== 'expects_response' || m.expects_response;
  }

  /** Answer a message as the human, exactly as the inbox does. */
  protected reply(id: string, body: string): void {
    const m = s.getMessage(this.ctx, id);
    s.sendMessage(this.ctx, { from: 'human', to: m.from, type: 'reply', body, reply_to: id });
    s.markRead(this.ctx, id, true);
  }

  /**
   * A tap on a message's Done, choice or Mark Read button. Returns a short note for the person when it did nothing:
   * the message is gone, or it was answered already (a second answer is refused).
   */
  protected tap(id: string, kind: 'done' | 'choice' | 'read', index = -1): string | undefined {
    let m: Message;
    try {
      m = s.getMessage(this.ctx, id);
    } catch {
      return 'That message is no longer in Yaho.';
    }
    if (kind === 'read') return void s.markRead(this.ctx, m.id, true);
    const answered = this.answerOf(m.id);
    if (answered !== undefined) return `Already answered: ${answered.slice(0, 150)}`;
    if (kind === 'done') this.reply(m.id, 'Done');
    else {
      const choice = m.choices?.[index];
      if (choice !== undefined) this.reply(m.id, choice);
    }
    return undefined;
  }

  private posted(id: string): boolean {
    return !!this.ctx.db.prepare(`SELECT 1 FROM ${this.table} WHERE message = ? LIMIT 1`).get(id);
  }

  private stateOf(id: string): string | undefined {
    const r = this.ctx.db.prepare('SELECT read FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? `${r.read ? 1 : 0}${this.answerOf(id) === undefined ? 0 : 1}` : undefined;
  }

  /** Call after posting or editing a post: what it shows now. */
  protected shownNow(id: string): void {
    const st = this.stateOf(id);
    if (st !== undefined) this.shown.set(id, st);
    if (this.shown.size > 500) this.shown.delete(this.shown.keys().next().value!);
  }

  /**
   * Posts what arrived since `since` and is not posted yet, oldest first and a page at a time. since moves past what
   * was posted or skipped, so the next catch-up does not look at it again; it stops at the first message that could
   * not be posted (WhatsApp's closed window), which stays waiting.
   */
  protected async postNew(live: () => boolean = () => true): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const since = this.settings.since;
      if (!since || !live()) return;
      const rows = this.ctx.db
        .prepare(
          `SELECT id, created FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND created >= ?
           AND id NOT IN (SELECT message FROM ${this.table}) ORDER BY created, id LIMIT ?`,
        )
        .all(since, PAGE) as Row[];
      let done = since;
      let stuck = false;
      for (const r of rows) {
        const m = s.getMessage(this.ctx, r.id as string);
        if (this.wanted(m)) {
          await this.post(m);
          if (!live()) return;
          if (!this.posted(m.id)) {
            stuck = true;
            break;
          }
        }
        done = r.created as string;
      }
      if (done !== this.settings.since && live()) this.save({ since: done } as Partial<Se>);
      if (stuck || rows.length < PAGE || done === since) return;
    }
  }

  /** Brings recent posts up to date with answers and reads made while disconnected; unchanged ones are left alone. */
  protected async refreshRecent(live: () => boolean = () => true): Promise<void> {
    const rows = this.ctx.db
      .prepare(`SELECT message FROM ${this.table} GROUP BY message ORDER BY MAX(created) DESC LIMIT 50`)
      .all() as Row[];
    for (const r of rows) {
      if (!live()) return;
      const id = r.message as string;
      const now = this.stateOf(id);
      const before = this.shown.get(id) ?? '00';
      if (now === undefined || now === before) continue;
      await this.refresh(id).catch((err) => this.fail(err));
    }
  }

  /** The unread messages not posted yet, for the Post Unread button. */
  async postBacklog(): Promise<number> {
    const rows = this.ctx.db
      .prepare(
        `SELECT id FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND read = 0
         AND id NOT IN (SELECT message FROM ${this.table}) ORDER BY created LIMIT 200`,
      )
      .all() as Row[];
    let n = 0;
    for (const r of rows) {
      const m = s.getMessage(this.ctx, r.id as string);
      if (!this.wanted(m)) continue;
      await this.post(m);
      n++;
    }
    return n;
  }

  /** One turn of Chat with Yaho; the conversation is kept per chat, briefly. Returns the answer (Markdown). */
  protected async converse(chatKey: string, text: string): Promise<string> {
    // Imported here: the assistant's modules reach the server, which imports the bridges.
    const { chat } = await import('../assistant/index.ts');
    const r = await chat(this.ctx, [...(this.chats.get(chatKey) ?? []), { role: 'user', content: text }]);
    this.chats.delete(chatKey);
    this.chats.set(chatKey, trimHistory(r.messages));
    if (this.chats.size > HISTORY_CHATS) this.chats.delete(this.chats.keys().next().value!);
    return lastAnswer(r.messages) ?? 'Done.';
  }

  /** Forgets every chat with Yaho (a new owner must not see the old one's). */
  protected forgetChats(): void {
    this.chats.clear();
  }
}
