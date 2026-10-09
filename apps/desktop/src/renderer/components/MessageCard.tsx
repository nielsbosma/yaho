import { Markdown } from './Markdown.tsx';
import { Bot, Check, Copy, Trash2, CornerDownRight, ExternalLink, HelpCircle, Info, ListChecks, Send, User } from 'lucide-react';
import { useState } from 'react';
import type { Message } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';
import { ago, Badge, Card } from './ui/display.tsx';
import { Textarea } from './ui/form.tsx';

const typeMeta = {
  question: { icon: HelpCircle, tone: 'accent' as const, label: 'Question' },
  instruction: { icon: ListChecks, tone: 'warn' as const, label: 'Instruction' },
  info: { icon: Info, tone: 'info' as const, label: 'Info' },
  reply: { icon: CornerDownRight, tone: 'neutral' as const, label: 'Reply' },
};

export const who = (addr: string) => (addr === 'human' ? 'You' : addr.replace(/^agent:/, ''));

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="group flex items-start gap-2 rounded-lg border border-line bg-code p-2.5">
      <pre className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed">{value}</pre>
      <Button
        size="sm"
        variant={done ? 'primary' : 'secondary'}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Check /> : <Copy />} {done ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export interface MessageCardProps {
  message: Message;
  /** Sends a reply. Resolves when stored. */
  onReply?: (body: string) => Promise<void>;
  onMarkRead?: (read: boolean) => void;
  onDiscard?: () => void;
  /** False when the sender no longer exists: replying is pointless, discarding is not. */
  canReply?: boolean;
  compact?: boolean;
}

/** One message, rendered for a human checkpoint: choices, steps with Open/Copy, one-click Done and a feedback box. */
export function MessageCard({ message: m, onReply, onMarkRead, onDiscard, canReply = true, compact }: MessageCardProps) {
  const meta = typeMeta[m.type] ?? typeMeta.info;
  const [text, setText] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const fromHuman = m.from === 'human';

  const reply = async (body: string) => {
    if (!onReply || !body.trim()) return;
    setSending(body);
    try {
      await onReply(body.trim());
      setSent(body.trim());
      setText('');
    } finally {
      setSending(null);
    }
  };

  return (
    <Card className={cn('overflow-hidden', !m.read && !fromHuman && 'border-accent/50', fromHuman && 'bg-hover/40')}>
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted">
        {fromHuman ? <User className="size-3.5" /> : <Bot className="size-3.5" />}
        {fromHuman ? (
          <span className="font-medium text-ink">You</span>
        ) : (
          <a href={href('agents', who(m.from))} className="font-medium text-ink hover:text-accent">
            {who(m.from)}
          </a>
        )}
        <span>→ {who(m.to)}</span>
        <Badge tone={meta.tone}>
          <meta.icon className="size-3" /> {meta.label}
        </Badge>
        {!m.read && !fromHuman && <span className="size-1.5 rounded-full bg-accent" title="Unread" />}
        <span className="ml-auto">{ago(m.created)}</span>
        {m.job && (
          <a href={href('jobs', m.job)} className="hover:text-accent" title="Open the job that sent this">
            job
          </a>
        )}
      </div>
      <div className="space-y-3 px-4 pt-1.5 pb-4">
        {m.title && <h3 className="font-serif text-[19px] leading-snug text-ink">{m.title}</h3>}
        {m.body && <Markdown className={cn('text-[14.5px] text-ink/90', compact && 'line-clamp-3')}>{m.body}</Markdown>}

        {!compact && m.steps?.length ? (
          <ol className="space-y-2">
            {m.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  {s.open && (
                    <Button variant="secondary" onClick={() => platform.openExternal(s.open!)} className="max-w-full">
                      <ExternalLink /> <span className="truncate">Open {s.open.replace(/^https?:\/\//, '')}</span>
                    </Button>
                  )}
                  {s.copy && <CopyValue value={s.copy} />}
                </div>
              </li>
            ))}
          </ol>
        ) : null}

        {!compact && onDiscard && (!onReply || !canReply || fromHuman) && (
          <div className="flex items-center gap-2 border-t border-line pt-3">
            {!canReply && !fromHuman && (
              <span className="text-xs text-muted">{who(m.from)} no longer exists, so it can't get a reply.</span>
            )}
            <Button variant="ghost" className="ml-auto" onClick={onDiscard} title="Discard this message">
              <Trash2 /> Discard
            </Button>
          </div>
        )}
        {!compact && onReply && canReply && !fromHuman && (
          <div className="space-y-2 border-t border-line pt-3">
            {sent ? (
              <div className="flex items-center gap-2 text-sm text-ok">
                <Check className="size-4" /> Replied: <span className="truncate text-ink">{sent}</span>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {m.choices?.map((c) => (
                    <Button key={c} variant="secondary" disabled={!!sending} onClick={() => void reply(c)}>
                      {c}
                    </Button>
                  ))}
                  {m.type !== 'question' || !m.choices?.length ? (
                    <Button
                      variant="primary"
                      disabled={!!sending}
                      onClick={() => void reply(text.trim() ? `Done. ${text.trim()}` : 'Done')}
                    >
                      <Check /> Done
                    </Button>
                  ) : null}
                  {onMarkRead && (
                    <Button variant="ghost" onClick={() => onMarkRead(!m.read)} className="ml-auto">
                      {m.read ? 'Mark Unread' : 'Mark Read'}
                    </Button>
                  )}
                  {onDiscard && (
                    <Button variant="ghost" onClick={onDiscard} title="Discard this message">
                      <Trash2 /> Discard
                    </Button>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  <Textarea
                    className="min-h-10"
                    rows={1}
                    value={text}
                    placeholder={m.type === 'question' ? 'Answer in your own words…' : 'Optional feedback…'}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void reply(text);
                    }}
                  />
                  <Button disabled={!text.trim() || !!sending} onClick={() => void reply(text)} title="Send (Ctrl+Enter)">
                    <Send />
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
