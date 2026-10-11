import { saveSettings } from '../config.ts';
import type { BusEvent, Ctx } from '../context.ts';
import { chat, type ChatMessage } from '../assistant/index.ts';
import type { Message } from '../store.ts';
import * as s from '../store.ts';
import { messageBlocks, senderName, toMrkdwn, type Block } from './format.ts';

type Row = Record<string, unknown>;

/** The few Slack Web API calls the bridge makes; the real WebClient, or a fake in tests. */
export interface SlackApi {
  authTest(): Promise<{ team?: string; user_id?: string }>;
  openDm(user: string): Promise<string>;
  post(args: { channel: string; text: string; blocks?: Block[]; username?: string; icon_emoji?: string; thread_ts?: string }): Promise<{ ts: string }>;
  update(args: { channel: string; ts: string; text: string; blocks: Block[] }): Promise<void>;
  remove(channel: string, ts: string): Promise<void>;
  ephemeral(channel: string, user: string, text: string): Promise<void>;
  openModal(triggerId: string, view: Block): Promise<void>;
  publishHome(user: string, view: Block): Promise<void>;
}

/** A Socket Mode connection: delivers each envelope (events_api, interactive, slash_commands) with its ack. */
export interface SlackSocket {
  on(event: 'envelope', fn: (type: string, body: Row, ack: (payload?: unknown) => Promise<void>) => void): void;
  on(event: 'state', fn: (connected: boolean) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
  team?: string;
  /** Whether Yaho knows whose inbox this is (the first person to open the app in Slack). */
  owner: boolean;
  error?: string;
}

/**
 * Mirrors the human's inbox into a Slack DM and takes answers back. Every message an agent sends the human is posted
 * as that agent; buttons, thread replies and ✓ reactions become replies, Done and Mark Read through the same store
 * functions the app uses, so agents cannot tell where an answer came from. Only the owner can act.
 */
export class SlackBridge {
  ctx: Ctx;
  api: SlackApi | null = null;
  socket: SlackSocket | null = null;
  status: SlackStatus = { configured: false, connected: false, owner: false };
  private dm: string | null = null;
  private chats = new Map<string, ChatMessage[]>();
  private listener = (e: BusEvent) => {
    if (e.type === 'message') void this.onMessage(e.message as Message & { deleted?: boolean }).catch((err) => this.fail(err));
  };
  /** Builds the clients from tokens; tests pass fakes. */
  connect: (bot: string, app: string) => Promise<{ api: SlackApi; socket: SlackSocket }>;

  constructor(ctx: Ctx, connect?: (bot: string, app: string) => Promise<{ api: SlackApi; socket: SlackSocket }>) {
    this.ctx = ctx;
    this.connect = connect ?? realClients;
  }

  get settings() {
    return this.ctx.settings.slack ?? {};
  }

  private setStatus(next: Partial<SlackStatus>) {
    this.status = { ...this.status, ...next, owner: !!this.settings.owner };
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'slack' });
  }

  private fail(err: unknown) {
    console.error(`[slack] ${(err as Error)?.stack ?? String(err)}`);
    this.setStatus({ error: (err as Error).message ?? String(err) });
  }

  async start(): Promise<void> {
    await this.stop();
    const { bot_token, app_token } = this.settings;
    if (!bot_token || !app_token) return this.setStatus({ configured: false, connected: false, error: undefined, team: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined });
    try {
      const { api, socket } = await this.connect(bot_token, app_token);
      this.api = api;
      this.socket = socket;
      const who = await api.authTest();
      this.setStatus({ team: who.team });
      socket.on('state', (connected) => {
        this.setStatus({ connected, ...(connected ? { error: undefined } : {}) });
        if (connected) void this.catchUp().catch((err) => this.fail(err));
      });
      socket.on('envelope', (type, body, ack) => void this.envelope(type, body, ack).catch((err) => this.fail(err)));
      this.ctx.bus.on('event', this.listener);
      await socket.start();
    } catch (err) {
      this.fail(err);
    }
  }

  async stop(): Promise<void> {
    this.ctx.bus.off('event', this.listener);
    const socket = this.socket;
    this.socket = null;
    this.api = null;
    this.dm = null;
    if (socket) await socket.stop().catch(() => undefined);
    if (this.status.connected) this.setStatus({ connected: false });
  }

  // ---------- out: the inbox into Slack ----------

  private async channel(): Promise<string | null> {
    if (this.dm) return this.dm;
    if (!this.api || !this.settings.owner) return null;
    this.dm = await this.api.openDm(this.settings.owner);
    return this.dm;
  }

  private postFor(id: string): { channel: string; ts: string } | undefined {
    return this.ctx.db.prepare('SELECT channel, ts FROM slack_posts WHERE message = ?').get(id) as { channel: string; ts: string } | undefined;
  }

  private answerOf(id: string): string | undefined {
    const r = this.ctx.db
      .prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human' ORDER BY created DESC LIMIT 1")
      .get(id) as Row | undefined;
    return r ? String(r.body) : undefined;
  }

  /** Whether a message to the human goes to Slack: all of them, or only those that wait for an answer. */
  private wanted(m: Message): boolean {
    if (m.to !== 'human' || m.from === 'human') return false;
    return this.settings.post !== 'expects_response' || m.expects_response;
  }

  async onMessage(m: Message & { deleted?: boolean }): Promise<void> {
    if (!this.api) return;
    if (m.deleted) {
      const p = this.postFor(m.id);
      if (p) {
        await this.api.remove(p.channel, p.ts).catch(() => undefined);
        this.ctx.db.prepare('DELETE FROM slack_posts WHERE message = ?').run(m.id);
      }
      return;
    }
    // An answer from the human, in the app or in Slack: the message it answers shows the outcome.
    if (m.from === 'human' && m.reply_to) return this.refresh(m.reply_to);
    if (!this.wanted(m)) return;
    if (this.postFor(m.id)) return this.refresh(m.id);
    await this.post(s.getMessage(this.ctx, m.id));
  }

  async post(m: Message): Promise<void> {
    const channel = await this.channel();
    if (!channel || !this.api) return;
    const { text, blocks } = messageBlocks(m, { answer: this.answerOf(m.id) });
    const res = await this.api.post({ channel, text, blocks, username: senderName(m), icon_emoji: ':robot_face:' });
    this.ctx.db.prepare('INSERT OR REPLACE INTO slack_posts (message, channel, ts, created) VALUES (?, ?, ?, ?)').run(m.id, channel, res.ts, new Date().toISOString());
  }

  async refresh(id: string): Promise<void> {
    const p = this.postFor(id);
    if (!p || !this.api) return;
    let m: Message;
    try {
      m = s.getMessage(this.ctx, id);
    } catch {
      return;
    }
    const { text, blocks } = messageBlocks(m, { answer: this.answerOf(id) });
    await this.api.update({ channel: p.channel, ts: p.ts, text, blocks });
  }

  /** On connect: post what arrived since Slack was set up and is not in Slack yet. */
  async catchUp(): Promise<void> {
    if (!this.settings.owner || !this.settings.since) return;
    const rows = this.ctx.db
      .prepare(
        `SELECT id FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND created >= ?
         AND id NOT IN (SELECT message FROM slack_posts) ORDER BY created`,
      )
      .all(this.settings.since) as Row[];
    for (const r of rows) {
      const m = s.getMessage(this.ctx, r.id as string);
      if (this.wanted(m)) await this.post(m);
    }
    // Bring recent Slack messages up to date: answers and reads made while Slack was not connected, and buttons
    // from an older Yaho.
    const posted = this.ctx.db.prepare('SELECT message FROM slack_posts ORDER BY created DESC LIMIT 50').all() as Row[];
    for (const r of posted) await this.refresh(r.message as string).catch((err) => this.fail(err));
  }

  /** Post the unread backlog from before Slack was connected. */
  async postBacklog(): Promise<number> {
    const rows = this.ctx.db
      .prepare(
        `SELECT id FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND read = 0
         AND id NOT IN (SELECT message FROM slack_posts) ORDER BY created`,
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

  // ---------- in: Slack into Yaho ----------

  /** The first person to open the app in Slack becomes its owner; from then on only they can act. */
  private async claim(user: string): Promise<boolean> {
    if (this.settings.owner) return this.settings.owner === user;
    this.ctx.settings.slack = { ...this.settings, owner: user, since: new Date().toISOString() };
    saveSettings(this.ctx.settings);
    this.setStatus({});
    const channel = await this.channel();
    const unread = s.unreadCount(this.ctx);
    if (channel && this.api)
      await this.api.post({
        channel,
        text: 'Yaho is connected.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*Yaho is connected.* New messages from your agents arrive here, and you can answer them with the buttons or in a thread.' } },
          ...(unread
            ? [
                {
                  type: 'actions',
                  elements: [{ type: 'button', action_id: 'yaho_backlog', text: { type: 'plain_text', text: `Post ${unread} Unread` }, value: 'backlog' }],
                },
              ]
            : []),
        ],
      });
    return true;
  }

  private async envelope(type: string, body: Row, ack: (payload?: unknown) => Promise<void>): Promise<void> {
    if (process.env.YAHO_DEBUG === '1') console.error(`[slack] ${type} ${String(body.type ?? (body.event as Row | undefined)?.type ?? body.command ?? '')}`);
    if (type === 'slash_commands') return ack(await this.command(body));
    // Everything else is acknowledged at once; Slack wants an answer within three seconds.
    await ack();
    if (type === 'events_api') return this.event(body.event as Row);
    if (type === 'interactive') return this.interactive(body);
  }

  private async owner(user: string, channel?: string): Promise<boolean> {
    if (await this.claim(user)) return true;
    if (channel && this.api) await this.api.ephemeral(channel, user, 'Only the person who connected Yaho can use it.').catch(() => undefined);
    return false;
  }

  /** Answer a message as the human, exactly as the inbox does. */
  private reply(id: string, body: string): void {
    const m = s.getMessage(this.ctx, id);
    s.sendMessage(this.ctx, { from: 'human', to: m.from, type: 'reply', body, reply_to: id });
    s.markRead(this.ctx, id, true);
  }

  async event(e: Row): Promise<void> {
    const user = e.user as string | undefined;
    if (e.type === 'app_home_opened' && user) {
      if (await this.owner(user)) await this.home(user);
      return;
    }
    if (e.type === 'reaction_added' && user) {
      if (!['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(e.reaction as string)) return;
      const item = e.item as Row;
      const id = this.messageAt(item.ts as string);
      if (id && (await this.owner(user))) s.markRead(this.ctx, id, true);
      return;
    }
    if (e.type === 'message' && user && !e.bot_id && !e.subtype && e.channel_type === 'im') {
      if (!(await this.owner(user, e.channel as string))) return;
      const text = String(e.text ?? '').trim();
      if (!text) return;
      const thread = e.thread_ts as string | undefined;
      const id = thread && thread !== e.ts ? this.messageAt(thread) : undefined;
      if (id) return this.reply(id, text);
      return this.ask(e.channel as string, text, (e.thread_ts as string) ?? undefined);
    }
  }

  private messageAt(ts: string): string | undefined {
    const r = this.ctx.db.prepare('SELECT message FROM slack_posts WHERE ts = ?').get(ts) as Row | undefined;
    return r ? (r.message as string) : undefined;
  }

  async interactive(body: Row): Promise<void> {
    const user = (body.user as Row).id as string;
    const channel = ((body.channel as Row | undefined)?.id as string | undefined) ?? undefined;
    if (body.type === 'view_submission') {
      const view = body.view as Row;
      if (view.callback_id !== 'yaho_reply' || !(await this.owner(user))) return;
      const values = (view.state as Row).values as Record<string, Record<string, { value?: string }>>;
      const text = values.reply?.text?.value?.trim();
      if (text) this.reply(view.private_metadata as string, text);
      return;
    }
    if (body.type !== 'block_actions' || !(await this.owner(user, channel))) return;
    for (const a of (body.actions as Row[]) ?? []) {
      const id = a.action_id as string;
      const value = (a.value as string) ?? '';
      if (id.startsWith('yaho_open_')) continue;
      if (id === 'yaho_done') this.reply(value, 'Done');
      else if (id.startsWith('yaho_choice_')) {
        // value is <message id>|<choice>; the choice itself may contain |. (Slack strips control characters.)
        const cut = value.indexOf('|');
        if (cut > 0) this.reply(value.slice(0, cut), value.slice(cut + 1));
      } else if (id === 'yaho_read') {
        const m = s.getMessage(this.ctx, value);
        s.markRead(this.ctx, value, !m.read);
      } else if (id === 'yaho_more') {
        const [what, msg] = String((a.selected_option as Row | undefined)?.value ?? '').split('|');
        if (what === 'discard' && msg) s.deleteMessage(this.ctx, msg);
      } else if (id === 'yaho_reply' && this.api) {
        const m = s.getMessage(this.ctx, value);
        await this.api.openModal(body.trigger_id as string, replyModal(m));
      } else if (id === 'yaho_backlog') {
        await this.postBacklog();
      } else if (id === 'yaho_run') {
        this.ctx.runner?.enqueue(value, 'manual', { detail: 'from Slack', force: true });
        await this.home(user);
      }
    }
  }

  // ---------- App Home, /yaho and chat ----------

  async home(user: string): Promise<void> {
    if (!this.api) return;
    const unread = s.listMessages(this.ctx, { to: 'human', unread: true, limit: 15 });
    const agents = s.listAgents(this.ctx);
    const blocks: Block[] = [
      { type: 'header', text: { type: 'plain_text', text: 'Yaho' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Inbox* · ${unread.length ? `${unread.length} unread` : 'all read'}` } },
      ...unread.map((m) => ({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*${m.from.replace(/^agent:/, '')}* · ${escapeText(m.title || m.body.slice(0, 80))}` }],
      })),
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: '*Agents*' } },
      ...agents.slice(0, 40).map((a) => ({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${a.enabled ? (a.running ? ':large_green_circle:' : ':white_circle:') : ':no_entry_sign:'} *${a.name}*${a.running ? ' · running' : a.enabled ? '' : ' · disabled'}`,
        },
        accessory: { type: 'button', action_id: 'yaho_run', text: { type: 'plain_text', text: 'Run Now' }, value: a.name },
      })),
    ];
    await this.api.publishHome(user, { type: 'home', blocks });
  }

  /** /yaho: run <agent>, send <agent> <text>, ask <question>, inbox, help. Answers privately. */
  async command(body: Row): Promise<unknown> {
    const user = body.user_id as string;
    if (!(await this.claim(user))) return { response_type: 'ephemeral', text: 'Only the person who connected Yaho can use it.' };
    const [verb = 'help', ...rest] = String(body.text ?? '').trim().split(/\s+/);
    const reply = (text: string) => ({ response_type: 'ephemeral', text });
    try {
      if (verb === 'run' && rest[0]) {
        if (!s.agentExists(this.ctx, rest[0])) return reply(`No agent named ${rest[0]}.`);
        this.ctx.runner?.enqueue(rest[0], 'manual', { detail: 'from Slack', force: true });
        return reply(`Started ${rest[0]}.`);
      }
      if (verb === 'send' && rest[0] && rest.length > 1) {
        s.sendMessage(this.ctx, { from: 'human', to: `agent:${rest[0]}`, type: 'info', body: rest.slice(1).join(' ') });
        return reply(`Sent to ${rest[0]}.`);
      }
      if (verb === 'inbox') {
        const unread = s.listMessages(this.ctx, { to: 'human', unread: true, limit: 20 });
        return reply(
          unread.length
            ? unread.map((m) => `• *${m.from.replace(/^agent:/, '')}*: ${escapeText(m.title || m.body.slice(0, 80))}`).join('\n')
            : 'Your inbox is all read.',
        );
      }
      if (verb === 'ask' && rest.length) {
        const channel = await this.channel();
        if (channel) void this.ask(channel, rest.join(' ')).catch((err) => this.fail(err));
        return reply('Asking Yaho; the answer comes in your DM.');
      }
    } catch (err) {
      return reply(`That did not work: ${(err as Error).message}`);
    }
    return reply('`/yaho run <agent>` · `/yaho send <agent> <message>` · `/yaho ask <question>` · `/yaho inbox`');
  }

  /** A DM that is not a thread reply goes to Chat with Yaho; the conversation is kept per DM, briefly. */
  async ask(channel: string, text: string, thread?: string): Promise<void> {
    if (!this.api) return;
    const history = [...(this.chats.get(channel) ?? []), { role: 'user' as const, content: text }];
    const thinking = await this.api.post({ channel, text: 'Thinking…', ...(thread ? { thread_ts: thread } : {}) });
    try {
      const r = await chat(this.ctx, history);
      this.chats.set(channel, r.messages.slice(-20));
      const answer = [...r.messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content as string | undefined ?? 'Done.';
      await this.api.update({ channel, ts: thinking.ts, text: answer.slice(0, 200), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(answer).slice(0, 2900) } }] });
    } catch (err) {
      await this.api.update({ channel, ts: thinking.ts, text: 'Error', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `That did not work: ${(err as Error).message}` } }] });
    }
  }
}

const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function replyModal(m: Message): Block {
  return {
    type: 'modal',
    callback_id: 'yaho_reply',
    private_metadata: m.id,
    title: { type: 'plain_text', text: 'Reply' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'context', elements: [{ type: 'mrkdwn', text: `To *${m.from.replace(/^agent:/, '')}* · ${escapeText(m.title || m.body.slice(0, 80))}` }] },
      { type: 'input', block_id: 'reply', label: { type: 'plain_text', text: 'Message' }, element: { type: 'plain_text_input', action_id: 'text', multiline: true } },
    ],
  };
}

/** The real clients: Slack's WebClient and SocketModeClient, behind the small interfaces above. */
async function realClients(bot: string, app: string): Promise<{ api: SlackApi; socket: SlackSocket }> {
  const { WebClient } = await import('@slack/web-api');
  const { SocketModeClient, LogLevel } = await import('@slack/socket-mode');
  const web = new WebClient(bot);
  const sm = new SocketModeClient({ appToken: app, logLevel: LogLevel.ERROR });
  const api: SlackApi = {
    authTest: async () => {
      const r = await web.auth.test();
      return { team: r.team, user_id: r.user_id };
    },
    openDm: async (user) => (await web.conversations.open({ users: user })).channel!.id!,
    post: async (args) => ({ ts: (await web.chat.postMessage(args as Parameters<typeof web.chat.postMessage>[0])).ts! }),
    update: async (args) => void (await web.chat.update(args as Parameters<typeof web.chat.update>[0])),
    remove: async (channel, ts) => void (await web.chat.delete({ channel, ts })),
    ephemeral: async (channel, user, text) => void (await web.chat.postEphemeral({ channel, user, text })),
    openModal: async (trigger_id, view) => void (await web.views.open({ trigger_id, view: view as never })),
    publishHome: async (user_id, view) => void (await web.views.publish({ user_id, view: view as never })),
  };
  const handlers: { envelope?: Parameters<SlackSocket['on']>[1]; state?: (c: boolean) => void } = {};
  sm.on('slack_event', ({ type, body, ack }: { type: string; body: Row; ack: (p?: unknown) => Promise<void> }) =>
    (handlers.envelope as ((t: string, b: Row, a: (p?: unknown) => Promise<void>) => void) | undefined)?.(type, body, ack),
  );
  sm.on('connected', () => handlers.state?.(true));
  sm.on('disconnected', () => handlers.state?.(false));
  sm.on('error', () => undefined);
  const socket: SlackSocket = {
    on: ((event: 'envelope' | 'state', fn: never) => {
      handlers[event] = fn;
    }) as SlackSocket['on'],
    start: async () => void (await sm.start()),
    stop: async () => void (await sm.disconnect()),
  };
  return { api, socket };
}
