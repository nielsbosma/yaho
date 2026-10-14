import { randomBytes } from 'node:crypto';
import { chat } from '../assistant/index.ts';
import type { Ctx } from '../context.ts';
import { InboxMirror, eq, errorText, inboxCommand } from '../mirror/index.ts';
import type { Message } from '../store.ts';
import * as s from '../store.ts';
import { escape as escapeText, messageBlocks, senderName, toMrkdwn, type Block } from './format.ts';

type Row = Record<string, unknown>;

/** The few Slack Web API calls the bridge makes; the real WebClient, or a fake in tests. */
export interface SlackApi {
  authTest(): Promise<{ team?: string; team_id?: string; user_id?: string }>;
  openDm(user: string): Promise<string>;
  post(args: {
    channel: string;
    text: string;
    blocks?: Block[];
    username?: string;
    icon_emoji?: string;
    thread_ts?: string;
  }): Promise<{ ts: string }>;
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
  /** Whether Yaho knows whose inbox this is (the person who sent the link code). */
  owner: boolean;
  /** Until then, the code to send (/yaho link <code>, or a DM to the app). */
  link_code?: string;
  error?: string;
}

/** settings.slack, with what the core manages: the link code, and the workspace the owner belongs to. */
type SlackSettings = NonNullable<Ctx['settings']['slack']>;

const NOT_OWNER = 'Only the person who connected Yaho can use it.';
const NOT_LINKED = 'Yaho is not connected to anyone yet: send `/yaho link <code>` with the code from Settings → Integrations → Slack.';

/**
 * Mirrors the human's inbox into a Slack DM and takes answers back. Every message an agent sends the human is posted
 * as that agent; buttons, thread replies and ✓ reactions become replies, Done and Mark Read through the same store
 * functions the app uses, so agents cannot tell where an answer came from. Only the owner can act: the person who sent
 * the one-time link code shown in Yaho.
 */
export class SlackBridge extends InboxMirror<SlackStatus, SlackSettings> {
  protected readonly chat = chat;
  protected readonly key = 'slack';
  protected readonly table = 'slack_posts';
  api: SlackApi | null = null;
  socket: SlackSocket | null = null;
  status: SlackStatus = { configured: false, connected: false, owner: false };
  private dm: string | null = null;
  /** Builds the clients from tokens; tests pass fakes. */
  connect: (bot: string, app: string) => Promise<{ api: SlackApi; socket: SlackSocket }>;

  constructor(ctx: Ctx, connect?: (bot: string, app: string) => Promise<{ api: SlackApi; socket: SlackSocket }>) {
    super(ctx);
    this.connect = connect ?? realClients;
  }

  protected derived(): Partial<SlackStatus> {
    return { owner: !!this.settings.owner, link_code: this.settings.owner ? undefined : this.settings.link_code };
  }

  /** The code whose sender becomes the owner. Made once until used. */
  linkCode(): string {
    if (!this.settings.link_code) this.save({ link_code: randomBytes(10).toString('hex') });
    return this.settings.link_code!;
  }

  async start(): Promise<void> {
    const live = this.begin();
    await this.close();
    if (!live()) return;
    const { bot_token, app_token } = this.settings;
    if (!bot_token || !app_token) return this.setStatus({ configured: false, connected: false, error: undefined, team: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined });
    let socket: SlackSocket | null = null;
    const drop = () => void socket?.stop().catch(() => undefined);
    try {
      const c = await this.connect(bot_token, app_token);
      socket = c.socket;
      if (!live()) return drop();
      const who = await c.api.authTest();
      if (!live()) return drop();
      // The owner is a user of one workspace: tokens for another start the link over.
      if (who.team_id && who.team_id !== this.settings.team_id) {
        const moved = !!this.settings.team_id;
        this.save({ team_id: who.team_id, ...(moved ? { owner: undefined, since: undefined, link_code: undefined } : {}) });
        if (moved) this.forgetChats();
      }
      this.api = c.api;
      this.socket = socket;
      if (!this.settings.owner) this.linkCode();
      this.setStatus({ team: who.team });
      socket.on('state', (connected) => {
        if (!live()) return;
        this.setStatus({ connected, ...(connected ? { error: undefined } : {}) });
        if (connected) void this.catchUp(live).catch((err) => this.fail(err));
      });
      socket.on('envelope', (type, body, ack) => {
        if (live()) void this.envelope(type, body, ack).catch((err) => this.fail(err));
      });
      this.listen();
      await socket.start();
    } catch (err) {
      if (live()) this.fail(err);
      else drop();
    }
  }

  async stop(): Promise<void> {
    this.begin();
    await this.close();
  }

  private async close(): Promise<void> {
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
    const api = this.api;
    const owner = this.settings.owner;
    if (!api || !owner) return null;
    const dm = await api.openDm(owner);
    if (this.api === api && this.settings.owner === owner) this.dm = dm;
    return dm;
  }

  private postFor(id: string): { channel: string; ts: string } | undefined {
    return this.ctx.db.prepare('SELECT channel, ts FROM slack_posts WHERE message = ?').get(id) as
      | { channel: string; ts: string }
      | undefined;
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
    this.ctx.db
      .prepare('INSERT OR REPLACE INTO slack_posts (message, channel, ts, created) VALUES (?, ?, ?, ?)')
      .run(m.id, channel, res.ts, new Date().toISOString());
    this.shownNow(m.id);
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
    this.shownNow(id);
  }

  /** On connect: post what arrived since the last catch-up, and update posts answered or read meanwhile. */
  async catchUp(live: () => boolean = () => true): Promise<void> {
    if (!this.settings.owner || !this.settings.since) return;
    await this.postNew(live);
    await this.refreshRecent(live);
  }

  // ---------- in: Slack into Yaho ----------

  /** The person who sends the link code becomes the owner; from then on only they can act. */
  private async link(user: string, code: string): Promise<boolean> {
    const want = this.settings.link_code;
    if (this.settings.owner || !want || !eq(code, want)) return false;
    this.save({ owner: user, since: new Date().toISOString(), link_code: undefined });
    this.dm = null;
    this.forgetChats();
    this.setStatus({});
    const channel = await this.channel();
    const unread = s.unreadCount(this.ctx);
    if (channel && this.api)
      await this.api.post({
        channel,
        text: 'Yaho is connected.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Yaho is connected.* New messages from your agents arrive here, and you can answer them with the buttons or in a thread.',
            },
          },
          ...(unread
            ? [
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      action_id: 'yaho_backlog',
                      text: { type: 'plain_text', text: `Post ${unread} Unread` },
                      value: 'backlog',
                    },
                  ],
                },
              ]
            : []),
        ],
      });
    return true;
  }

  private isOwner(user: string | undefined): boolean {
    return !!user && !!this.settings.owner && this.settings.owner === user;
  }

  private async envelope(type: string, body: Row, ack: (payload?: unknown) => Promise<void>): Promise<void> {
    if (process.env.YAHO_DEBUG === '1')
      console.error(`[slack] ${type} ${String(body.type ?? (body.event as Row | undefined)?.type ?? body.command ?? '')}`);
    if (type === 'slash_commands') return ack(await this.command(body));
    // Everything else is acknowledged at once; Slack wants an answer within three seconds.
    await ack();
    if (type === 'events_api') return this.event(body.event as Row);
    if (type === 'interactive') return this.interactive(body);
  }

  /** Whether user may act; others are told so privately where there is a channel to say it in. */
  private async owner(user: string, channel?: string): Promise<boolean> {
    if (this.isOwner(user)) return true;
    if (channel && this.api) await this.api.ephemeral(channel, user, this.settings.owner ? NOT_OWNER : NOT_LINKED).catch(() => undefined);
    return false;
  }

  async event(e: Row): Promise<void> {
    const user = e.user as string | undefined;
    // Opening the app or reacting never links anyone; only the code does.
    if (e.type === 'app_home_opened' && user) {
      if (this.isOwner(user)) await this.home(user);
      return;
    }
    if (e.type === 'reaction_added' && user) {
      if (!this.isOwner(user) || !['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check'].includes(e.reaction as string)) return;
      const id = this.messageAt((e.item as Row).ts as string);
      if (id) s.markRead(this.ctx, id, true);
      return;
    }
    if (e.type === 'message' && user && !e.bot_id && !e.subtype && e.channel_type === 'im') {
      const text = String(e.text ?? '').trim();
      if (!this.isOwner(user)) {
        const code = /^(?:\/?yaho\s+)?(?:link\s+)?(\S+)$/i.exec(text)?.[1];
        if (code && (await this.link(user, code))) return;
        await this.owner(user, e.channel as string);
        return;
      }
      if (!text) return;
      const thread = e.thread_ts as string | undefined;
      const id = thread && thread !== e.ts ? this.messageAt(thread) : undefined;
      if (id) return this.reply(id, text);
      return this.ask(e.channel as string, text, thread);
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
      if (view.callback_id !== 'yaho_reply' || !this.isOwner(user)) return;
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
      const choice = /^yaho_choice_(\d+)$/.exec(id);
      if (id === 'yaho_done' || choice) {
        // value is <message id>|<choice index>; the index is also in the action id (an older Yaho put the choice's text here).
        const msg = value.split('|')[0]!;
        const note = this.tap(msg, choice ? 'choice' : 'done', choice ? Number(choice[1]) : -1);
        if (note) {
          if (channel && this.api) await this.api.ephemeral(channel, user, note).catch(() => undefined);
          await this.refresh(msg).catch(() => undefined);
        }
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

  /** /yaho: link <code>, run <agent>, send <agent> <text>, ask <question>, inbox, help. Answers privately. */
  async command(body: Row): Promise<unknown> {
    const user = body.user_id as string;
    const reply = (text: string) => ({ response_type: 'ephemeral', text });
    const [verb = 'help', ...rest] = String(body.text ?? '')
      .trim()
      .split(/\s+/);
    if (!this.isOwner(user)) {
      if (verb === 'link' && rest[0] && (await this.link(user, rest[0])))
        return reply('Yaho is connected: your inbox comes to your DMs with Yaho.');
      return reply(this.settings.owner ? NOT_OWNER : verb === 'link' ? 'That is not the link code shown in Yaho.' : NOT_LINKED);
    }
    if (verb === 'link') return reply('Yaho is already connected to you.');
    if (verb === 'ask' && rest.length) {
      const channel = await this.channel();
      if (channel) void this.ask(channel, rest.join(' ')).catch((err) => this.fail(err));
      return reply('Asking Yaho; the answer comes in your DM.');
    }
    return reply(
      inboxCommand(this.ctx, verb, rest, { via: 'Slack', esc: escapeText }) ??
        '`/yaho run <agent>` · `/yaho send <agent> <message>` · `/yaho ask <question>` · `/yaho inbox`',
    );
  }

  /** A DM that is not a thread reply goes to Chat with Yaho; the conversation is kept per DM, briefly. */
  async ask(channel: string, text: string, thread?: string): Promise<void> {
    const api = this.api;
    if (!api) return;
    const thinking = await api.post({ channel, text: 'Thinking…', ...(thread ? { thread_ts: thread } : {}) });
    try {
      const answer = await this.converse(channel, text);
      await api.update({
        channel,
        ts: thinking.ts,
        text: answer.slice(0, 200),
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(answer).slice(0, 2900) } }],
      });
    } catch (err) {
      await api.update({
        channel,
        ts: thinking.ts,
        text: 'Error',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `That did not work: ${escapeText(errorText(err))}` } }],
      });
    }
  }
}

function replyModal(m: Message): Block {
  return {
    type: 'modal',
    callback_id: 'yaho_reply',
    private_metadata: m.id,
    title: { type: 'plain_text', text: 'Reply' },
    submit: { type: 'plain_text', text: 'Send' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `To *${m.from.replace(/^agent:/, '')}* · ${escapeText(m.title || m.body.slice(0, 80))}` }],
      },
      {
        type: 'input',
        block_id: 'reply',
        label: { type: 'plain_text', text: 'Message' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true },
      },
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
