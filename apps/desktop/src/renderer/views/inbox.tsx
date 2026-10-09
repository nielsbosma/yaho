import { Resizer, usePanelWidth } from '../components/Resizer.tsx';
import { Inbox, PenLine } from 'lucide-react';
import { useState } from 'react';
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
  const inbox = useApi<Message[]>(`/api/messages?to=human${filter === 'unread' ? '&unread=1' : ''}`, onMessage);
  const [compose, setCompose] = useState(false);
  const selected = route[1];
  const [listWidth, setListWidth] = usePanelWidth('inbox-list', 380, 260, 720);
  const unread = inbox.data?.filter((m) => !m.read).length ?? 0;

  return (
    <div className="flex h-full">
      <div className="relative flex shrink-0 flex-col border-r border-line" style={{ width: listWidth }}>
        <Resizer width={listWidth} onChange={setListWidth} side="right" initial={380} />
        <div className="flex items-center gap-2 border-b border-line px-5 pt-6 pb-4">
          <h1 className="font-serif text-[26px]">Inbox</h1>
          <span className="text-sm text-muted">{unread ? `${unread} unread` : ''}</span>
          <Button size="sm" className="ml-auto" onClick={() => setCompose(true)}>
            <PenLine /> New
          </Button>
        </div>
        <div className="flex gap-1 px-4 py-2 text-xs">
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
              className={cn('block border-b border-line px-5 py-3 transition-colors hover:bg-hover/50', selected === m.id && 'bg-hover')}
            >
              <div className="flex items-center gap-2 text-xs">
                {!m.read ? <span className="size-2 shrink-0 rounded-full bg-accent" /> : <span className="size-2 shrink-0" />}
                <span className={cn('truncate', !m.read ? 'font-semibold text-ink' : 'text-muted')}>{who(m.from)}</span>
                <span className="text-muted">· {m.type}</span>
                <span className="ml-auto shrink-0 text-muted">{ago(m.created)}</span>
              </div>
              <div className={cn('mt-1 truncate pl-4 text-sm', !m.read ? 'font-medium' : 'text-ink/80')}>
                {m.title || m.body.slice(0, 80)}
              </div>
              <div className="mt-0.5 truncate pl-4 text-xs text-muted">{m.body.split('\n')[0]}</div>
            </a>
          ))}
          {inbox.data?.length === 0 && (
            <Empty icon={<Inbox />} title={filter === 'unread' ? 'All caught up' : 'No messages yet'}>
              Agents send questions, instructions and results here. They never wait for you.
            </Empty>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <Thread id={selected} />
        ) : (
          <Empty title="Pick a message">Questions get one-click answers; instructions get Open and Copy buttons and a Done.</Empty>
        )}
      </div>
      <Compose open={compose} onClose={() => setCompose(false)} />
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

function Compose({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useApi<Agent[]>(open ? '/api/agents' : null);
  const [to, setTo] = useState('');
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
