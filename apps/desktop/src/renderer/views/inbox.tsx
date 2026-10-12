import { plainText } from '../lib/plainText.ts';
import { Resizer, usePanelWidth } from '../components/Resizer.tsx';
import { Inbox, Mail, MailOpen, MoreHorizontal, PenLine, Search, Trash2 } from 'lucide-react';
import { useContextMenu } from '../components/ContextMenu.tsx';
import { useEffect, useState } from 'react';
import { MessageCard, who } from '../components/MessageCard.tsx';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { ago, Empty, ErrorNote } from '../components/ui/display.tsx';
import { Field, Input, Select, Textarea } from '../components/ui/form.tsx';
import { api, useApi, type Agent, type Message } from '../lib/api.ts';
import { go, href } from '../lib/router.ts';
import type { ViewProps } from './index.tsx';

const onMessage = (e: { type: string }) => e.type === 'message';

export function InboxView({ route }: ViewProps) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [search, setSearch] = useState('');
  // The search runs a moment after typing stops.
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const inbox = useApi<Message[]>(
    `/api/messages?to=human${filter === 'unread' ? '&unread=1' : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    onMessage,
  );
  const [compose, setCompose] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const selected = route[1];
  const menu = useContextMenu();
  const [listWidth, setListWidth] = usePanelWidth('inbox-list', 380, 260, 720);
  const unread = inbox.data?.filter((m) => !m.read).length ?? 0;

  return (
    <div className="relative flex h-full">
      <div className="relative flex shrink-0 flex-col border-r border-line" style={{ width: listWidth }}>
        <Resizer width={listWidth} onChange={setListWidth} side="right" initial={380} />
        <div className="app-drag flex items-center gap-2 border-b border-line px-5 pt-6 pb-4">
          <h1 className="font-serif text-[26px]">Inbox</h1>
          <span className="text-sm text-muted">{unread ? `${unread} unread` : ''}</span>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            title="More"
            onClick={(e) =>
              menu.open(e, [
                { label: 'Mark All Read', icon: <MailOpen />, onSelect: () => void api('/api/inbox/read-all', { method: 'POST' }) },
                { label: 'Delete All', icon: <Trash2 />, danger: true, onSelect: () => setDeletingAll(true) },
              ])
            }
          >
            <MoreHorizontal />
          </Button>
          <Button size="sm" onClick={() => setCompose(true)}>
            <PenLine /> New
          </Button>
        </div>
        <div className="relative px-5 pt-3">
          <Search className="pointer-events-none absolute top-1/2 left-7.5 mt-1.5 size-3.5 -translate-y-1/2 text-muted" />
          <Input
            className="h-8 pl-7 text-sm"
            placeholder="Search messages"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
          />
        </div>
        <div className="flex gap-1 px-5 py-2 text-xs">
          {(['all', 'unread'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'cursor-pointer rounded-md px-2 py-1 capitalize',
                filter === f ? 'bg-hover font-medium' : 'text-muted hover:text-ink',
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inbox.data?.map((m) => (
            <a
              key={m.id}
              href={href('inbox', m.id)}
              onContextMenu={(e) =>
                menu.open(e, [
                  {
                    label: m.read ? 'Mark Unread' : 'Mark Read',
                    icon: m.read ? <MailOpen /> : <Mail />,
                    onSelect: () => void api(`/api/messages/${m.id}/read`, { body: { read: !m.read } }),
                  },
                  {
                    label: 'Delete',
                    icon: <Trash2 />,
                    danger: true,
                    onSelect: async () => {
                      await api(`/api/messages/${m.id}`, { method: 'DELETE' });
                      if (selected === m.id) go('inbox');
                    },
                  },
                ])
              }
              className={cn(
                'relative block border-b border-line px-5 py-3 transition-colors hover:bg-hover/50',
                selected === m.id && 'bg-hover',
              )}
            >
              <div className="flex items-center gap-2 text-xs">
                {!m.read && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                <span className={cn('truncate', !m.read ? 'font-semibold text-ink' : 'text-muted')}>{who(m.from)}</span>
                <span className="text-muted">· {m.type}</span>
                <span className="ml-auto shrink-0 text-muted">{ago(m.created)}</span>
              </div>
              <div className={cn('mt-1 truncate text-sm', !m.read ? 'font-medium' : 'text-ink/80')}>
                {m.title || plainText(m.body).slice(0, 80)}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">{plainText(m.body).slice(0, 160)}</div>
            </a>
          ))}
          {inbox.data?.length === 0 && (
            <Empty icon={<Inbox />} title={filter === 'unread' ? 'All caught up' : 'No messages yet'}>
              Agents send questions, instructions and results here. They never wait for you.
            </Empty>
          )}
        </div>
      </div>
      {/* The space above the message, beside the window controls, moves the window like a title bar. */}
      <div aria-hidden className="titlebar-strip app-drag absolute top-0 right-0 z-10" style={{ left: listWidth }} />
      <div className="titlebar-below min-w-0 flex-1 overflow-y-auto">
        {selected && <Thread id={selected} />}
      </div>
      <Compose open={compose} onClose={() => setCompose(false)} />
      <Dialog
        open={deletingAll}
        onClose={() => setDeletingAll(false)}
        title="Delete All Messages?"
        footer={
          <>
            <Button onClick={() => setDeletingAll(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api('/api/inbox/delete-all', { method: 'POST' });
                setDeletingAll(false);
                go('inbox');
              }}
            >
              Delete All
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Every message your agents sent you is deleted{inbox.data?.length ? ` (${inbox.data.length})` : ''}, here and in Slack. Messages you sent
          to agents stay in their inboxes.
        </p>
      </Dialog>
      {menu.element}
    </div>
  );
}

function Thread({ id }: { id: string }) {
  const thread = useApi<Message[]>(`/api/messages/${id}/thread`, onMessage);
  const agents = useApi<Agent[]>('/api/agents', (e) => e.type === 'changed' && e.entity === 'agents');
  const exists = (addr: string) => !addr.startsWith('agent:') || !agents.data || agents.data.some((a) => `agent:${a.name}` === addr);
  const [error, setError] = useState<string | null>(null);
  const main = thread.data?.find((m) => m.id === id);

  // Opening a message marks it read; the agent sees that state too.
  const [marked, setMarked] = useState<string | null>(null);
  if (main && !main.read && main.to === 'human' && marked !== id) {
    setMarked(id);
    void api(`/api/messages/${id}/read`, { body: { read: true } });
  }

  if (thread.error) return <Empty title="Message not found">{thread.error}</Empty>;
  if (!thread.data) return null;
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-8">
      <ErrorNote>{error}</ErrorNote>
      {thread.data.map((m) => (
        <MessageCard
          key={m.id}
          message={m}
          compact={m.id !== id && m.from !== 'human'}
          answered={thread.data!.filter((r) => r.reply_to === m.id && r.from === 'human').at(-1)?.body}
          onReply={
            m.to === 'human'
              ? async (body) => {
                  setError(null);
                  try {
                    await api('/api/messages', { body: { to: m.from, type: 'reply', body, reply_to: m.id } });
                  } catch (e) {
                    setError((e as Error).message);
                    throw e;
                  }
                }
              : undefined
          }
          onMarkRead={m.to === 'human' ? (read) => void api(`/api/messages/${m.id}/read`, { body: { read } }) : undefined}
          canReply={exists(m.from)}
          onDiscard={async () => {
            await api(`/api/messages/${m.id}`, { method: 'DELETE' });
            if (m.id === id) go('inbox');
          }}
        />
      ))}
    </div>
  );
}

export function Compose({ open, onClose, defaultTo }: { open: boolean; onClose: () => void; defaultTo?: string }) {
  const agents = useApi<Agent[]>(open ? '/api/agents' : null);
  const [to, setTo] = useState(defaultTo ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Message an Agent"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!to || !body.trim()}
            onClick={async () => {
              setError(null);
              try {
                const m = await api<Message>('/api/messages', { body: { to: `agent:${to}`, type: 'info', title, body } });
                onClose();
                setTitle('');
                setBody('');
                go('inbox', m.id);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorNote>{error}</ErrorNote>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose an Agent…</option>
            {agents.data?.map((a) => (
              <option key={a.name}>{a.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Message" hint="Agents with an inbox trigger start a job when this arrives.">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

const FILTERS = [
  ['all', 'All'],
  ['from', 'From the Agent'],
  ['to', 'To the Agent'],
  ['unread', 'Unread'],
] as const;

/**
 * One agent's messages: what it sent you or other agents, and what was sent to it. Newest first; a click opens the
 * whole thread in the Inbox.
 */
export function AgentInbox({ agent }: { agent: string }) {
  const addr = `agent:${agent}`;
  const messages = useApi<Message[]>(`/api/messages?involving=${encodeURIComponent(addr)}`, onMessage);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [compose, setCompose] = useState(false);
  const all = [...(messages.data ?? [])].sort((a, b) => b.created.localeCompare(a.created));
  const shown = all.filter((m) =>
    filter === 'from' ? m.from === addr : filter === 'to' ? m.to === addr : filter === 'unread' ? !m.read && m.to === 'human' : true,
  );
  const unread = all.filter((m) => !m.read && m.to === 'human').length;
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 text-xs">
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={cn('cursor-pointer rounded-md px-2 py-1', filter === id ? 'bg-hover font-medium' : 'text-muted hover:text-ink')}
            >
              {label}
              {id === 'unread' && unread ? ` (${unread})` : ''}
            </button>
          ))}
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setCompose(true)}>
          <PenLine /> Message {agent}
        </Button>
      </div>
      {shown.map((m) => (
        <div
          key={m.id}
          role="link"
          tabIndex={0}
          title="Open in the Inbox"
          onClick={(e) => !(e.target as HTMLElement).closest('a, button') && go('inbox', m.id)}
          onKeyDown={(e) => e.key === 'Enter' && go('inbox', m.id)}
          className="cursor-pointer rounded-xl transition-shadow hover:shadow-sm"
        >
          <MessageCard message={m} compact />
        </div>
      ))}
      {messages.data && !shown.length && (
        <Empty icon={<Inbox />} title={filter === 'all' ? 'No messages yet' : 'Nothing here'}>
          {filter === 'all' ? `Messages ${agent} sends or receives show up here.` : 'Try another filter.'}
        </Empty>
      )}
      <Compose open={compose} onClose={() => setCompose(false)} defaultTo={agent} />
    </div>
  );
}
