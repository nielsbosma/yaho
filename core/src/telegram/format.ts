import { splitText } from '../mirror/util.ts';
import type { Message } from '../store.ts';

/** Telegram's limit on one message's text (after entities are parsed; the HTML tags do not count, so stay well under). */
export const TEXT_MAX = 3800;
/** callback_data is at most 64 bytes. */
const DATA_MAX = 64;

export type Button = { text: string; callback_data: string };
export type Keyboard = Button[][];

export const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (t: string) => escapeHtml(t).replace(/"/g, '&quot;');

/** Inline Markdown to Telegram HTML: bold, italic, strike, code spans and links. Everything else is escaped. */
function inline(line: string): string {
  return line
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      const links: string[] = [];
      const marked = part.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => {
        links.push(`<a href="${attr(u)}">${escapeHtml(t)}</a>`);
        return `\uE000${links.length - 1}\uE000`;
      });
      return escapeHtml(marked)
        .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_m, a?: string, b?: string) => `<b>${a ?? b}</b>`)
        .replace(
          /(?<![*\w])\*(?!\*)([^*\n]+?)\*(?![*\w])|(?<![_\w])_(?!_)([^_\n]+?)_(?![_\w])/g,
          (_m, a?: string, b?: string) => `<i>${a ?? b}</i>`,
        )
        .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')
        .replace(/\uE000(\d+)\uE000/g, (_m, i: string) => links[Number(i)]!);
    })
    .join('');
}

/** Markdown, as agents write it, to Telegram HTML. A ```copy Label fence becomes the label in bold over a code block. */
export function toTelegram(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      if (fence[1] === 'copy' && fence[2]) out.push(`<b>${escapeHtml(fence[2])}</b>`);
      out.push(`<pre>${escapeHtml(body.join('\n'))}</pre>`);
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1]!.replace(/^\*\*(.*)\*\*$/, '$1'))}</b>`);
      continue;
    }
    const item = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (item) {
      out.push(`${item[1]!.replace(/ {2}/g, ' ')}• ${inline(item[2]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A hard cut moves back to before a tag or an entity (&amp;) it would split. */
function safeCut(text: string, at: number): number {
  const amp = text.lastIndexOf('&', at - 1);
  if (amp >= 0 && amp > at - 8 && !text.slice(amp, at).includes(';')) at = amp;
  const open = text.lastIndexOf('<', at - 1);
  return open > text.lastIndexOf('>', at - 1) && open > 0 ? open : at;
}

/** Cut text into message-sized pieces at paragraph or line breaks, never inside a tag's pair (pre blocks are kept whole when they fit). */
export function chunks(text: string, max = TEXT_MAX): string[] {
  return splitText(text, max, safeCut).map(balance);
}

/** Close tags a cut left open, and drop closing tags whose opening went to the previous piece. */
function balance(piece: string): string {
  const open: string[] = [];
  let out = '';
  for (const part of piece.split(/(<\/?[a-z]+(?:\s[^>]*)?>)/)) {
    const tag = /^<(\/)?([a-z]+)/.exec(part);
    if (!tag) out += part;
    else if (!tag[1]) {
      open.push(tag[2]!);
      out += part;
    } else if (open.at(-1) === tag[2]) {
      open.pop();
      out += part;
    }
  }
  return (
    out +
    open
      .reverse()
      .map((t) => `</${t}>`)
      .join('')
  );
}

const agentOf = (addr: string) => (addr.startsWith('agent:') ? addr.slice(6) : addr);
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** The message's text: the sender, title and body, then Open links, Copy values, artifacts and the outcome. */
export function messageText(m: Message, opts: { answer?: string } = {}): string {
  const parts = [
    `<b>${escapeHtml(agentOf(m.from))}</b> via Yaho`,
    m.title ? `<b>${escapeHtml(m.title)}</b>` : '',
    m.body ? toTelegram(m.body) : '',
  ];
  for (const s of m.steps ?? []) {
    // Telegram refuses a whole message over a link it does not support, so only http(s) becomes one.
    if ('open' in s && s.open)
      parts.push(/^https?:\/\//i.test(s.open) ? `Open: <a href="${attr(s.open)}">${escapeHtml(s.open)}</a>` : `Open: <code>${escapeHtml(s.open)}</code>`);
    if ('copy' in s && s.copy) parts.push(`<pre>${escapeHtml(s.copy)}</pre>`);
  }
  if (m.artifacts?.length) parts.push(`<i>${m.artifacts.length} artifact${m.artifacts.length === 1 ? '' : 's'} in Yaho</i>`);
  if (opts.answer !== undefined) parts.push(`✅ <i>Answered: ${escapeHtml(cut(opts.answer, 300))}</i>`);
  else if (m.read && !m.expects_response) parts.push('☑️ <i>Read</i>');
  return parts.filter(Boolean).join('\n\n');
}

/** What a button does: its data is <action>:<message id>[:<choice index>]. */
export type Action = { kind: 'choice'; message: string; index: number } | { kind: 'done' | 'read' | 'backlog'; message: string };

export function parseAction(data: string): Action | undefined {
  const [kind, message = '', index] = data.split(':');
  if (kind === 'c' && message && index !== undefined) return { kind: 'choice', message, index: Number(index) };
  if (kind === 'd' && message) return { kind: 'done', message };
  if (kind === 'r' && message) return { kind: 'read', message };
  if (kind === 'b') return { kind: 'backlog', message: '' };
  return undefined;
}

/** The buttons a message has while it waits for something: its choices (or Done), and Mark Read. */
export function keyboard(m: Message, answered: boolean): Keyboard {
  const rows: Keyboard = [];
  const data = (d: string) => (Buffer.byteLength(d) <= DATA_MAX ? d : null);
  if (m.expects_response && !answered) {
    (m.choices ?? []).slice(0, 8).forEach((c, i) => {
      const d = data(`c:${m.id}:${i}`);
      if (d) rows.push([{ text: cut(c, 60), callback_data: d }]);
    });
    const done = data(`d:${m.id}`);
    if (done && (m.type !== 'question' || !m.choices?.length)) rows.push([{ text: 'Done', callback_data: done }]);
  }
  const read = data(`r:${m.id}`);
  if (!m.read && !answered && read) rows.push([{ text: 'Mark Read', callback_data: read }]);
  return rows;
}

/** One inbox message as Telegram messages: text pieces, the last one with the buttons. */
export function messageParts(m: Message, opts: { answer?: string } = {}): Array<{ text: string; keyboard: Keyboard }> {
  const pieces = chunks(messageText(m, opts));
  const kb = keyboard(m, opts.answer !== undefined);
  return pieces.map((text, i) => ({ text, keyboard: i === pieces.length - 1 ? kb : [] }));
}
