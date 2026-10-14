import { splitText } from '../mirror/util.ts';
import type { Message } from '../store.ts';

export type Payload = Record<string, unknown>;

/** WhatsApp's limits: a text message, an interactive message's body, a button title, a list row's title and description. */
export const TEXT_MAX = 4096;
const BODY_MAX = 1024;
const BUTTON_MAX = 20;
const ROW_MAX = 24;
const ROW_DESC_MAX = 72;

/** Inline Markdown to WhatsApp: *bold*, _italic_, ~strike~; links as "text (url)". Code spans are left alone. */
function inline(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return part;
      return part
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => (t === u ? u : `${t} (${u})`))
        .replace(/(?<![*\w])\*(?!\*)([^*\n]+?)\*(?![*\w])/g, '_$1_')
        .replace(/\*\*([^*\n]+?)\*\*|__([^_\n]+?)__/g, (_m, a?: string, b?: string) => `*${a ?? b}*`)
        .replace(/~~([^~\n]+?)~~/g, '~$1~');
    })
    .join('');
}

/** Markdown, as agents write it, to WhatsApp's formatting. A ```copy Label fence becomes the label in bold over a code block. */
export function toWhatsApp(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*(\S*)\s*(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      if (fence[1] === 'copy' && fence[2]) out.push(`*${fence[2]}*`);
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

/** Cut text into message-sized pieces at paragraph or line breaks. */
export const chunks = (text: string, max = TEXT_MAX): string[] => splitText(text, max);

const agentOf = (addr: string) => (addr.startsWith('agent:') ? addr.slice(6) : addr);
const cut = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** The message's text: the sender, title and body, then Open links, Copy values and artifacts. */
export function messageText(m: Message): string {
  const parts = [`*${agentOf(m.from)}* via Yaho`, m.title ? `*${m.title}*` : '', m.body ? toWhatsApp(m.body) : ''];
  for (const s of m.steps ?? []) {
    if ('open' in s && s.open) parts.push(`Open: ${s.open}`);
    if ('copy' in s && s.copy) parts.push('```' + s.copy + '```');
  }
  if (m.artifacts?.length) parts.push(`_${m.artifacts.length} artifact${m.artifacts.length === 1 ? '' : 's'} in Yaho_`);
  return parts.filter(Boolean).join('\n\n');
}

/** What a button or list row does: its id is <action>:<message id>[:<choice index>]. */
export type Action = { kind: 'choice'; message: string; index: number } | { kind: 'done' | 'read' | 'backlog'; message: string };

export function parseAction(id: string): Action | undefined {
  const [kind, message = '', index] = id.split(':');
  if (kind === 'choice' && message && index !== undefined) return { kind, message, index: Number(index) };
  if ((kind === 'done' || kind === 'read' || kind === 'backlog') && (message || kind === 'backlog')) return { kind, message };
  return undefined;
}

/**
 * One inbox message as WhatsApp messages (without the recipient): the text, with buttons while it waits for something.
 * Up to three short actions are reply buttons, more or longer ones a list. A body too long for an interactive message
 * goes first as text, and the buttons follow under a short note. Returns each payload with whether it holds the actions.
 */
export function messagePayloads(m: Message): Array<{ payload: Payload; actions: boolean }> {
  const text = messageText(m);
  const rows: Array<{ id: string; title: string; description?: string }> = [];
  let choiceList = '';
  if (m.expects_response) {
    const choices = (m.choices ?? []).slice(0, 8);
    const long = choices.some((c) => c.length > BUTTON_MAX);
    if (long) choiceList = choices.map((c, i) => `*${String.fromCharCode(65 + i)}.* ${c}`).join('\n');
    choices.forEach((c, i) =>
      rows.push({
        id: `choice:${m.id}:${i}`,
        title: long ? String.fromCharCode(65 + i) : c,
        ...(long ? { description: cut(c, ROW_DESC_MAX) } : {}),
      }),
    );
    if (m.type !== 'question' || !m.choices?.length) rows.push({ id: `done:${m.id}`, title: 'Done' });
  }
  if (!m.read) rows.push({ id: `read:${m.id}`, title: 'Mark Read' });
  if (!rows.length) return chunks(text).map((body) => ({ payload: { type: 'text', text: { body, preview_url: false } }, actions: false }));

  const full = [text, choiceList].filter(Boolean).join('\n\n');
  const out: Array<{ payload: Payload; actions: boolean }> = [];
  let body = full;
  if (full.length > BODY_MAX) {
    for (const c of chunks(text)) out.push({ payload: { type: 'text', text: { body: c, preview_url: false } }, actions: false });
    body = [`↑ ${cut(m.title || 'The message above', 200)}`, choiceList].filter(Boolean).join('\n\n').slice(0, BODY_MAX);
  }
  const footer = { text: 'Or reply to this message to answer' };
  const buttons = rows.length <= 3 && rows.every((r) => r.title.length <= BUTTON_MAX && !r.description);
  const interactive = buttons
    ? {
        type: 'button',
        body: { text: body },
        footer,
        action: { buttons: rows.map((r) => ({ type: 'reply', reply: { id: r.id, title: r.title } })) },
      }
    : {
        type: 'list',
        body: { text: body },
        footer,
        action: {
          button: 'Answer',
          sections: [{ title: 'Answer', rows: rows.slice(0, 10).map((r) => ({ ...r, title: cut(r.title, ROW_MAX) })) }],
        },
      };
  out.push({ payload: { type: 'interactive', interactive }, actions: true });
  return out;
}
