import type { Message } from '../store.ts';

/** Slack caps a section's text at 3,000 characters; leave room for the "continues in Yaho" note. */
const SECTION_MAX = 2900;

const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline Markdown to Slack mrkdwn: bold, italic, links, inline code. Code spans are left alone. */
function inline(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return part;
      return escape(part)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<${u}|${t}>`)
        .replace(/(?<![*\w])\*(?!\*)([^*\n]+?)\*(?![*\w])/g, '_$1_')
        .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_m, a?: string, b?: string) => `*${a ?? b}*`)
        .replace(/~~([^~\n]+?)~~/g, '~$1~');
    })
    .join('');
}

/**
 * Markdown, as agents write it, to Slack mrkdwn. Headings become bold lines, list markers bullets, fenced code stays
 * fenced, and a ```copy Label fence becomes the label in bold over a code block (Slack shows a copy button on it).
 */
export function toMrkdwn(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      if (fence[1] === 'copy' && fence[2]) out.push(`*${escape(fence[2])}*`);
      out.push('```' + body.join('\n') + '```');
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`*${inline(heading[1]!).replace(/^\*(.*)\*$/, '$1')}*`);
      continue;
    }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item) {
      out.push(`${item[1]!.replace(/ {2}/g, ' ')}• ${inline(item[2]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cut text into section-sized pieces at paragraph or line breaks, never inside a code block if it can help it. */
function chunks(text: string, max = SECTION_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n\n', max);
    if (at < max / 2) at = rest.lastIndexOf('\n', max);
    if (at < max / 2) at = max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export type Block = Record<string, unknown>;

export interface PostState {
  /** The human's answer, when there is one. */
  answer?: string;
}

/** A message's whole body fits in about this many sections; longer ones end with a note. */
const MAX_SECTIONS = 4;

const agentOf = (addr: string) => (addr.startsWith('agent:') ? addr.slice(6) : addr);

/** The Block Kit layout of one inbox message, with its buttons while it is open, or its outcome once answered or read. */
export function messageBlocks(m: Message, state: PostState = {}): { text: string; blocks: Block[] } {
  const blocks: Block[] = [];
  const title = m.title ? `*${escape(m.title)}*` : '';
  const body = m.body ? toMrkdwn(m.body) : '';
  const parts = chunks([title, body].filter(Boolean).join('\n'));
  for (const p of parts.slice(0, MAX_SECTIONS)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: p } });
  if (parts.length > MAX_SECTIONS) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_The rest of this message is in Yaho._' }] });

  // Steps: Open links as buttons, Copy values as code blocks.
  const opens = (m.steps ?? []).flatMap((s) => ('open' in s && s.open ? [s.open] : []));
  for (const s of m.steps ?? []) if ('copy' in s && s.copy) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + s.copy + '```' } });
  if (opens.length)
    blocks.push({
      type: 'actions',
      elements: opens.slice(0, 5).map((url, i) => ({
        type: 'button',
        action_id: `yaho_open_${i}`,
        text: { type: 'plain_text', text: `Open ${url.replace(/^https?:\/\//, '').slice(0, 60)}` },
        url,
      })),
    });

  if (m.artifacts?.length)
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${m.artifacts.length} artifact${m.artifacts.length === 1 ? '' : 's'} in Yaho` }] });

  const done = state.answer !== undefined;
  if (done || (m.read && !m.expects_response)) {
    const outcome = done ? `:white_check_mark: Answered: ${escape(state.answer!.slice(0, 200))}` : ':ballot_box_with_check: Read';
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] });
  } else {
    const elements: Block[] = [];
    if (m.expects_response) {
      // Slack buttons hold 75 characters: long choices are listed as A, B, C… with short lettered buttons.
      const choices = (m.choices ?? []).slice(0, 5);
      const long = choices.some((c) => c.length > 28);
      if (long)
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: choices.map((c, i) => `*${String.fromCharCode(65 + i)}.* ${escape(c)}`).join('\n') },
        });
      choices.forEach((c, i) =>
        elements.push({
          type: 'button',
          action_id: `yaho_choice_${i}`,
          text: { type: 'plain_text', text: long ? String.fromCharCode(65 + i) : c.slice(0, 75) },
          value: `${m.id}|${c}`.slice(0, 2000),
        }),
      );
      if (m.type !== 'question' || !m.choices?.length)
        elements.push({ type: 'button', action_id: 'yaho_done', style: 'primary', text: { type: 'plain_text', text: 'Done' }, value: m.id });
    }
    elements.push({ type: 'button', action_id: 'yaho_reply', text: { type: 'plain_text', text: 'Reply' }, value: m.id });
    elements.push({ type: 'button', action_id: 'yaho_read', text: { type: 'plain_text', text: m.read ? 'Mark Unread' : 'Mark Read' }, value: m.id });
    elements.push({
      type: 'overflow',
      action_id: 'yaho_more',
      options: [{ text: { type: 'plain_text', text: 'Discard' }, value: `discard|${m.id}` }],
      confirm: {
        title: { type: 'plain_text', text: 'Discard This Message?' },
        text: { type: 'mrkdwn', text: 'It is deleted from your Yaho inbox.' },
        confirm: { type: 'plain_text', text: 'Discard' },
        deny: { type: 'plain_text', text: 'Cancel' },
        style: 'danger',
      },
    });
    blocks.push({ type: 'actions', block_id: 'yaho_actions', elements });
  }

  const text = `${agentOf(m.from)}: ${m.title || m.body.slice(0, 120)}`;
  return { text, blocks };
}

/** The bot's display name for a message: the agent, as the decision says ("bugsink via Yaho"). */
export const senderName = (m: Message) => (m.from.startsWith('agent:') ? `${agentOf(m.from)} via Yaho` : 'Yaho');
