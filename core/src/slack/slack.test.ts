import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { getMessage, sendMessage } from '../store.ts';
import { SlackBridge, type SlackApi, type SlackSocket } from './bridge.ts';
import { messageBlocks, toMrkdwn } from './format.ts';
import { slackCreateUrl } from './manifest.ts';

describe('toMrkdwn', () => {
  it('converts the Markdown agents write', () => {
    expect(toMrkdwn('# Report\n**Signups** up, *slightly*. See [the board](https://x.io/b).\n- one\n- two')).toBe(
      '*Report*\n*Signups* up, _slightly_. See <https://x.io/b|the board>.\n• one\n• two',
    );
    expect(toMrkdwn('```copy Note for Anna\nHej Anna!\n```')).toBe('*Note for Anna*\n```Hej Anna!```');
    expect(toMrkdwn('a < b & `x < y`')).toBe('a &lt; b &amp; `x &lt; y`');
    expect(toMrkdwn('```\n<!channel> & co\n```')).toBe('```&lt;!channel&gt; &amp; co```');
  });

  it('builds a create-app link with the manifest', () => {
    const url = new URL(slackCreateUrl());
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.bot).toContain('chat:write.customize');
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

/** A fake Slack: records calls, and lets the test deliver envelopes as Slack would. */
function fakeSlack() {
  const calls: Array<{ op: string; args: unknown }> = [];
  let ts = 1000;
  let deliver: ((type: string, body: Record<string, unknown>, ack: (p?: unknown) => Promise<void>) => void) | undefined;
  let state: ((c: boolean) => void) | undefined;
  const acks: unknown[] = [];
  const api: SlackApi = {
    authTest: async () => ({ team: 'Bosma', user_id: 'UBOT' }),
    openDm: async () => 'D1',
    post: async (args) => {
      calls.push({ op: 'post', args });
      return { ts: String(++ts) };
    },
    update: async (args) => void calls.push({ op: 'update', args }),
    remove: async (channel, t) => void calls.push({ op: 'remove', args: { channel, ts: t } }),
    ephemeral: async (channel, user, text) => void calls.push({ op: 'ephemeral', args: { channel, user, text } }),
    openModal: async (trigger, view) => void calls.push({ op: 'modal', args: { trigger, view } }),
    publishHome: async (user, view) => void calls.push({ op: 'home', args: { user, view } }),
  };
  const socket: SlackSocket = {
    on: ((event: string, fn: never) => {
      if (event === 'envelope') deliver = fn;
      else state = fn;
    }) as SlackSocket['on'],
    start: async () => state?.(true),
    stop: async () => undefined,
  };
  const send = async (type: string, body: Record<string, unknown>) => {
    deliver!(type, body, async (p) => void acks.push(p));
    await new Promise((r) => setTimeout(r, 80));
  };
  return { api, socket, calls, acks, send };
}

const tick = () => new Promise((r) => setTimeout(r, 80));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-slack-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO agents (name, created, updated) VALUES ('scout', ?, ?)").run(now, now);
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('SlackBridge', () => {
  let slack: ReturnType<typeof fakeSlack>;
  let bridge: SlackBridge;
  beforeEach(async () => {
    slack = fakeSlack();
    ctx.settings.slack = { bot_token: 'xoxb-t', app_token: 'xapp-t' };
    bridge = new SlackBridge(ctx, async () => ({ api: slack.api, socket: slack.socket }));
    await bridge.start();
  });

  it('mirrors the inbox: links the owner by code, posts as the agent, and takes answers back', async () => {
    expect(bridge.status).toMatchObject({ configured: true, connected: true, team: 'Bosma', owner: false });
    const code = bridge.status.link_code!;
    expect(code).toMatch(/^[0-9a-f]{20}$/);

    // Opening the app, reacting, tapping or a wrong code links nobody; the code does.
    await slack.send('events_api', { event: { type: 'app_home_opened', user: 'USOMEONE' } });
    await slack.send('events_api', {
      event: { type: 'reaction_added', user: 'USOMEONE', reaction: 'white_check_mark', item: { ts: '1' } },
    });
    await slack.send('interactive', {
      type: 'block_actions',
      user: { id: 'USOMEONE' },
      channel: { id: 'D9' },
      actions: [{ action_id: 'yaho_backlog', value: 'backlog' }],
    });
    await slack.send('slash_commands', { user_id: 'USOMEONE', text: 'link nope' });
    await slack.send('events_api', {
      event: { type: 'message', channel_type: 'im', channel: 'D9', user: 'USOMEONE', text: 'hello', ts: '1' },
    });
    expect(ctx.settings.slack?.owner).toBeUndefined();
    expect(slack.calls.filter((c) => c.op === 'ephemeral').length).toBe(2);
    await slack.send('slash_commands', { user_id: 'UNIELS', text: `link ${code}` });
    expect(ctx.settings.slack).toMatchObject({ owner: 'UNIELS' });
    expect((ctx.settings.slack as { link_code?: string }).link_code).toBeUndefined();
    expect(bridge.status).toMatchObject({ owner: true, link_code: undefined });
    expect(slack.calls.some((c) => c.op === 'post' && (c.args as { text: string }).text === 'Yaho is connected.')).toBe(true);
    // The used code links no one else.
    await slack.send('slash_commands', { user_id: 'USOMEONE', text: `link ${code}` });
    expect(ctx.settings.slack?.owner).toBe('UNIELS');

    // A question from an agent is posted as that agent, with its choices.
    const q = sendMessage(ctx, {
      from: 'agent:scout',
      to: 'human',
      type: 'question',
      title: 'Spend $5?',
      body: 'For **ads**',
      choices: ['Yes', 'No'],
    });
    await tick();
    const posted = slack.calls.filter((c) => c.op === 'post').at(-1)!.args as { username: string; blocks: Array<Record<string, unknown>> };
    expect(posted.username).toBe('scout via Yaho');
    const actions = posted.blocks.find((b) => b.block_id === 'yaho_actions') as { elements: Array<{ action_id: string; value?: string }> };
    expect(actions.elements.map((e) => e.action_id)).toEqual(['yaho_choice_0', 'yaho_choice_1', 'yaho_reply', 'yaho_read', 'yaho_more']);
    expect(actions.elements[1]!.value).toBe(`${q.id}|1`);

    // Clicking Yes answers it, marks it read, and the Slack message shows the outcome.
    await slack.send('interactive', {
      type: 'block_actions',
      user: { id: 'UNIELS' },
      channel: { id: 'D1' },
      actions: [actions.elements[0]],
    });
    const answer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(q.id) as { body: string };
    expect(answer.body).toBe('Yes');
    expect(getMessage(ctx, q.id).read).toBe(true);
    const update = slack.calls.filter((c) => c.op === 'update').at(-1)!.args as {
      blocks: Array<{ type: string; elements?: Array<{ text: string }> }>;
    };
    expect(JSON.stringify(update.blocks)).toContain('Answered: Yes');
    expect(update.blocks.some((b) => b.type === 'actions')).toBe(false);

    // A second tap (an old button) is refused.
    await slack.send('interactive', {
      type: 'block_actions',
      user: { id: 'UNIELS' },
      channel: { id: 'D1' },
      actions: [actions.elements[1]],
    });
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(q.id)).toEqual({ n: 1 });
    expect(slack.calls.filter((c) => c.op === 'ephemeral').at(-1)!.args).toMatchObject({ text: 'Already answered: Yes' });

    // A thread reply under an instruction answers it in the person's own words.
    const ins = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'instruction', title: 'Add the DNS record' });
    await tick();
    const insTs = String(1000 + slack.calls.filter((c) => c.op === 'post').length);
    await slack.send('events_api', {
      event: {
        type: 'message',
        channel_type: 'im',
        channel: 'D1',
        user: 'UNIELS',
        text: 'Done, took a minute',
        ts: '9999',
        thread_ts: insTs,
      },
    });
    const insAnswer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(ins.id) as {
      body: string;
    };
    expect(insAnswer.body).toBe('Done, took a minute');

    // A ✓ reaction on an info message marks it read.
    const info = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'Weekly report' });
    await tick();
    const infoTs = String(1000 + slack.calls.filter((c) => c.op === 'post').length);
    await slack.send('events_api', {
      event: { type: 'reaction_added', user: 'UNIELS', reaction: 'white_check_mark', item: { ts: infoTs } },
    });
    expect(getMessage(ctx, info.id).read).toBe(true);
  });

  it('starts once when starts overlap', async () => {
    let sockets = 0;
    let stopped = 0;
    const many = new SlackBridge(ctx, async () => {
      await tick();
      sockets++;
      return { api: slack.api, socket: { ...slack.socket, stop: async () => void stopped++ } };
    });
    // A second start while the first waits for Slack: the first's connection is dropped.
    const first = many.start();
    await new Promise((r) => setTimeout(r, 10));
    await Promise.all([first, many.start(), many.start()]);
    expect(sockets).toBe(2);
    expect(stopped).toBe(1);
    expect(many.status.connected).toBe(true);
    // One listener: a new message is posted once.
    ctx.settings.slack = { ...ctx.settings.slack!, owner: 'UNIELS', since: new Date().toISOString() };
    await bridge.stop();
    const before = slack.calls.filter((c) => c.op === 'post').length;
    sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'Once' });
    await tick();
    expect(slack.calls.filter((c) => c.op === 'post').length).toBe(before + 1);
    await many.stop();
  });

  it('starts the link over for another workspace', async () => {
    ctx.settings.slack = { ...ctx.settings.slack!, owner: 'UNIELS', since: new Date().toISOString() };
    let team = 'T1';
    const b = new SlackBridge(ctx, async () => ({
      api: { ...slack.api, authTest: async () => ({ team: 'X', team_id: team }) },
      socket: slack.socket,
    }));
    await bridge.stop();
    await b.start();
    expect(ctx.settings.slack?.owner).toBe('UNIELS');
    team = 'T2';
    await b.start();
    expect(ctx.settings.slack?.owner).toBeUndefined();
    expect(b.status.link_code).toBeTruthy();
    await b.stop();
  });

  it('only lets the owner act, and can post just the messages that expect a response', async () => {
    ctx.settings.slack = { ...ctx.settings.slack!, owner: 'UNIELS', since: new Date().toISOString(), post: 'expects_response' };
    await bridge.start();
    const before = slack.calls.filter((c) => c.op === 'post').length;
    sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'FYI' });
    const q = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'question', title: 'Go?' });
    await tick();
    expect(slack.calls.filter((c) => c.op === 'post').length).toBe(before + 1);

    await slack.send('interactive', {
      type: 'block_actions',
      user: { id: 'USOMEONE' },
      channel: { id: 'D1' },
      actions: [{ action_id: 'yaho_done', value: q.id }],
    });
    expect(getMessage(ctx, q.id).read).toBe(false);
    expect(slack.calls.at(-1)!.op).toBe('ephemeral');

    await slack.send('slash_commands', { user_id: 'UNIELS', text: 'inbox' });
    const reply = slack.acks.at(-1) as { text: string };
    expect(reply.text).toContain('Go?');
  });
});

describe('messageBlocks', () => {
  it('shows Done only when a response is expected, and the outcome once read', () => {
    const base = { id: 'm', from: 'agent:a', to: 'human', title: 'T', body: 'B', reply_to: null, hop: 0, job: null, created: '' };
    const ids = (b: ReturnType<typeof messageBlocks>) =>
      ((b.blocks.find((x) => x.block_id === 'yaho_actions') as { elements: Array<{ action_id: string }> } | undefined)?.elements ?? []).map(
        (e) => e.action_id,
      );
    expect(ids(messageBlocks({ ...base, type: 'instruction', read: false, expects_response: true }))).toContain('yaho_done');
    expect(ids(messageBlocks({ ...base, type: 'info', read: false, expects_response: false }))).not.toContain('yaho_done');
    expect(ids(messageBlocks({ ...base, type: 'info', read: true, expects_response: false }))).toEqual([]);
  });
});
