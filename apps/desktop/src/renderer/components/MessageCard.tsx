import { Markdown } from './Markdown.tsx';
import { uploadAttachment, useAttachments } from './Attachments.tsx';
import { Bot, Check, Copy, Trash2, CornerDownRight, ExternalLink, HelpCircle, Info, ListChecks, Send, User, Reply } from 'lucide-react';
import { useState } from 'react';
import { useApi, type Artifact, type Message } from '../lib/api.ts';
import { ArtifactGrid } from '../views/artifacts.tsx';
import { platform } from '../lib/platform.ts';
import { chatAboutJob } from '../lib/chat.ts';
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

export const who = (addr: string) => (addr === 'human' ? 'You' : addr.replace(/^(agent|email|sms):/, ''));

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
  onReply?: (body: string, attachments?: string[]) => Promise<void>;
  onMarkRead?: (read: boolean) => void;
  onDiscard?: () => void;
  /** False when the sender no longer exists: replying is pointless, discarding is not. */
  canReply?: boolean;
  compact?: boolean;
  /** Your answer, when you already replied (here or in Slack): hides the choices and Done. */
  answered?: string;
}

/**
 * One message, rendered for a human checkpoint: choices, steps with Open/Copy, and, when the agent waits for an answer
 * (expects_response), one-click Done and a feedback box. Other messages offer a Reply that opens the box on demand.
 */
export function MessageCard({ message: m, onReply, onMarkRead, onDiscard, canReply = true, compact, answered }: MessageCardProps) {
  const meta = typeMeta[m.type] ?? typeMeta.info;
  const [text, setText] = useState('');
  const files = useAttachments();
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const fromHuman = m.from === 'human';
  const expects = m.expects_response ?? (m.type === 'question' || m.type === 'instruction');
  const [replying, setReplying] = useState(false);
  const longChoices = (m.choices ?? []).some((c) => c.length > 28);

  const reply = async (body: string) => {
    const n = files.items.length;
    if (!onReply || (!body.trim() && !n)) return;
    setSending(body);
    try {
      const paths = n ? await Promise.all(files.items.map((x) => uploadAttachment(x.file))) : undefined;
      await onReply(body.trim(), paths);
      setSent(body.trim() || `${n} file${n === 1 ? '' : 's'}`);
      setText('');
      files.clear();
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
            Job
          </a>
        )}
        {m.job && (
          <button
            type="button"
            onClick={() => chatAboutJob(m.job!)}
            className="cursor-pointer hover:text-accent"
            title="Ask the agent about this in Chat with Yaho"
          >
            Follow Up
          </button>
        )}
      </div>
      <div className="space-y-3 px-4 pt-1.5 pb-4">
        {m.title && <h3 className="font-serif text-[19px] leading-snug text-ink">{m.title}</h3>}
        {m.body && <Markdown className={cn('text-[14.5px] text-ink/90', compact && 'line-clamp-3')}>{m.body}</Markdown>}

        {!compact && (m.job || m.artifacts?.length) ? <MessageArtifacts id={m.id} /> : null}

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
        {/* Once answered, your reply shows as its own card below, so the choices and box go away. */}
        {!compact && onReply && canReply && !fromHuman && !(sent ?? answered) && (
          <div className="space-y-2 border-t border-line pt-3">
            {/* Long choices read better as a list of options that wrap; short ones stay buttons. */}
            {expects && longChoices && (
              <div className="space-y-1.5">
                {m.choices!.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    disabled={!!sending}
                    onClick={() => void reply(c)}
                    className={cn(
                      'flex w-full cursor-pointer items-start gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm leading-snug transition-colors',
                      'hover:border-accent/50 hover:bg-accent/5 disabled:cursor-default disabled:opacity-60',
                      sending === c && 'border-accent bg-accent/10',
                    )}
                  >
                    <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span className="min-w-0 flex-1">{c}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {expects &&
                !longChoices &&
                m.choices?.map((c) => (
                  <Button key={c} variant="secondary" disabled={!!sending} onClick={() => void reply(c)}>
                    {c}
                  </Button>
                ))}
              {expects && (m.type !== 'question' || !m.choices?.length) ? (
                <Button
                  variant="primary"
                  disabled={!!sending}
                  onClick={() => void reply(text.trim() ? `Done. ${text.trim()}` : 'Done')}
                >
                  <Check /> Done
                </Button>
              ) : null}
              {!expects && (
                <Button
                  variant="secondary"
                  onClick={() => setReplying(!replying)}
                  title="Write to the agent; it reads it on its next run"
                >
                  <Reply /> Reply
                </Button>
              )}
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
            {(expects || replying) && files.list}
            {(expects || replying) && (
              <div className="relative">
                <Textarea
                  autoFocus={replying}
                  className="min-h-24 pb-11"
                  rows={4}
                  onPaste={files.paste}
                  value={text}
                  placeholder={m.type === 'question' ? 'Answer in your own words…' : expects ? 'Optional feedback…' : 'Write a reply… (paste screenshots or attach files)'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void reply(text);
                  }}
                />
                <div className="absolute right-4 bottom-2 flex items-center gap-1">
                  {files.button}
                  <Button
                    size="icon"
                    disabled={(!text.trim() && !files.items.length) || !!sending}
                    onClick={() => void reply(text)}
                    title="Send (Ctrl+Enter)"
                  >
                    <Send />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** What the message attached, or what its job made: thumbnails that open in the artifact viewer. */
function MessageArtifacts({ id }: { id: string }) {
  const arts = useApi<Artifact[]>(`/api/messages/${id}/artifacts`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  if (!arts.data?.length) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-muted">
        {arts.data.length} artifact{arts.data.length === 1 ? '' : 's'}
      </div>
      <ArtifactGrid artifacts={arts.data} />
    </div>
  );
}
