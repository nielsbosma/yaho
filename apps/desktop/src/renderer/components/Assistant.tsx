import { JobChat } from './JobChat.tsx';
import { Markdown } from './Markdown.tsx';
import { uploadAttachment, useAttachments } from './Attachments.tsx';
import { Resizer, usePanelWidth } from './Resizer.tsx';
import { ArrowUp, Check, ChevronRight, Square, SquarePen, Sparkles, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { ChatFocus } from '../lib/chat.ts';
import { go } from '../lib/router.ts';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}
interface Step {
  tool: string;
  args: unknown;
  ok: boolean;
  result: unknown;
}
/** What the panel shows: the conversation, plus the actions taken for each answer. */
interface Turn {
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  steps?: Step[];
}

/** A chat lasts as long as the panel is open: closing it (or Ctrl+J) discards the conversation. */
const empty = (): { history: ChatMessage[]; turns: Turn[] } => ({ history: [], turns: [] });

const label = (tool: string) => tool.replace(/_/g, ' ');

/** A long path shows its last two parts (the full path is in the tooltip). */
const short = (subject: string) => {
  const parts = subject.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 && subject.length > 32 ? `…/${parts.slice(-2).join('/')}` : subject;
};

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const args = step.args as Record<string, unknown>;
  const subject = String(
    args.name ?? args.id ?? args.to ?? args.path ?? (typeof args.yaml === 'string' ? (/name:\s*(\S+)/.exec(args.yaml)?.[1] ?? '') : ''),
  );
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={subject || undefined}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 text-left whitespace-nowrap text-muted hover:text-ink"
      >
        {step.ok ? <Check className="size-3.5 shrink-0 text-ok" /> : <XCircle className="size-3.5 shrink-0 text-danger" />}
        <span className="shrink-0">{label(step.tool)}</span>
        {subject && <code className="min-w-0 truncate text-ink/80">{short(subject)}</code>}
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-code p-2 whitespace-pre-wrap">
          {typeof args.yaml === 'string' ? args.yaml : JSON.stringify(step.args, null, 2)}
          {'\n→ '}
          {JSON.stringify(step.result, null, 2).slice(0, 2000)}
        </pre>
      )}
    </div>
  );
}

export function Assistant({
  onClose,
  job,
  focus,
  onLeaveJob,
  onLeaveFocus,
}: {
  onClose: () => void;
  job: string | null;
  focus: ChatFocus | null;
  onLeaveJob: () => void;
  onLeaveFocus: () => void;
}) {
  const [state, setState] = useState(empty);
  const [width, setWidth] = usePanelWidth('assistant', 400, 320, 760);
  const [text, setText] = useState('');
  const files = useAttachments();
  const [busy, setBusy] = useState(false);
  const running = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  // A new subject starts a new conversation.
  useEffect(() => {
    setState(empty());
    setError(null);
    input.current?.focus();
  }, [focus?.kind, focus?.name]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.turns.length, busy]);

  const send = async (msg: string) => {
    const typed = msg.trim();
    if ((!typed && !files.items.length) || busy) return;
    setError(null);
    setText('');
    const added = files.items;
    files.clear();
    // Images go to the model to look at; other files are uploaded, and the chat reads them by path.
    let pics: string[];
    let paths: string[];
    try {
      pics = await Promise.all(added.filter((x) => x.preview).map((x) => toDataUrl(x.file)));
      paths = await Promise.all(added.filter((x) => !x.preview).map((x) => uploadAttachment(x.file)));
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const content = [typed, ...paths.map((p) => `Attached file: ${p}`)].filter(Boolean).join('\n');
    const parts = pics.length
      ? [
          ...(content ? [{ type: 'text' as const, text: content }] : []),
          ...pics.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ]
      : content;
    const history: ChatMessage[] = [...state.history, { role: 'user', content: parts }];
    const turns: Turn[] = [...state.turns, { role: 'user', text: content, images: pics }];
    setState({ history, turns });
    setBusy(true);
    const stop = (running.current = new AbortController());
    try {
      const r = await api<{ messages: ChatMessage[]; steps: Step[]; navigate?: string[] }>('/api/assistant', {
        body: { messages: history, focus: focus ? { [focus.kind]: focus.name } : undefined },
        signal: stop.signal,
      });
      const last = r.messages.at(-1)?.content;
      const answer = typeof last === 'string' ? last : '';
      const next = { history: r.messages, turns: [...turns, { role: 'assistant' as const, text: answer, steps: r.steps }] };
      setState(next);
      if (r.navigate?.length) go(...r.navigate);
    } catch (e) {
      if (stop.signal.aborted) setState({ history, turns: [...turns, { role: 'assistant', text: '_Stopped._' }] });
      else setError((e as Error).message);
    } finally {
      running.current = null;
      setBusy(false);
      input.current?.focus();
    }
  };

  const reset = () => {
    setState(empty());
    setError(null);
  };

  return (
    <aside className="relative flex shrink-0 flex-col border-l border-line bg-sidebar" style={{ width }}>
      <Resizer width={width} onChange={setWidth} side="left" initial={400} />
      <div className="app-drag titlebar-clear flex h-14 shrink-0 items-center gap-2 border-b border-line pl-4 [--titlebar-pad:1rem]">
        <Sparkles className="size-4 shrink-0 text-accent" />
        {/* The title drops out, rather than wrapping, when the panel is too narrow for it. */}
        <div className="@container min-w-0 flex-1">
          <span className="hidden font-serif text-lg whitespace-nowrap @[8.5rem]:inline">Chat with Yaho</span>
        </div>
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            size="icon"
            variant="ghost"
            title="New Chat"
            onClick={() => {
              reset();
              onLeaveJob();
              onLeaveFocus();
            }}
          >
            <SquarePen />
          </Button>
          <Button size="icon" variant="ghost" title="Close (Ctrl+J)" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>

      {job ? (
        <JobChat job={job} onLeave={onLeaveJob} />
      ) : (
        <>
          {focus && (
            <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-4 py-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-muted">
                About {focus.kind} <span className="font-medium text-ink">{focus.name}</span>
              </span>
              <button type="button" onClick={onLeaveFocus} title="Chat about anything" className="cursor-pointer text-muted hover:text-ink">
                <X className="size-3.5" />
              </button>
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {!state.turns.length && (
              <p className="text-sm text-muted">
                {focus?.kind === 'agent'
                  ? `Ask about ${focus.name}: how it works, why it did something, what it costs. Or ask for a change, like a better briefing, another model or a schedule, and Yaho makes it.`
                  : focus
                    ? `Ask about ${focus.name}: what it is for, which agents work on it, what they made. Or ask for a change, like a sharper briefing or another agent on it, and Yaho makes it.`
                    : 'Ask for anything you can do in Yaho: create or change agents, projects and resources, run jobs, read your inbox, adjust settings.'}
              </p>
            )}
            {state.turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="ml-8 space-y-2 rounded-xl bg-hover px-3 py-2 text-sm break-words whitespace-pre-wrap">
                  {t.images?.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {t.images.map((src, j) => (
                        <img key={j} src={src} alt="Pasted screenshot" className="max-h-32 max-w-full rounded-md border border-line" />
                      ))}
                    </div>
                  ) : null}
                  {t.text}
                </div>
              ) : (
                <div key={i} className="space-y-2">
                  {t.steps?.length ? (
                    <div className="space-y-1">
                      {t.steps.map((s, j) => (
                        <StepRow key={j} step={s} />
                      ))}
                    </div>
                  ) : null}
                  {t.text && <Markdown className="text-sm">{t.text}</Markdown>}
                </div>
              ),
            )}
            {busy && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <span className="size-2 animate-pulse rounded-full bg-accent" /> Working…
              </div>
            )}
            {error && <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-sm text-danger">{error}</div>}
            <div ref={bottom} />
          </div>

          <div className="border-t border-line p-3">
            <div className="rounded-xl border border-line bg-panel p-2 focus-within:border-accent/50">
              {files.list && <div className="mb-2">{files.list}</div>}
              <div className="flex items-end gap-2">
                <textarea
                  onPaste={files.paste}
                  ref={input}
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                  placeholder={focus ? `Ask about ${focus.name}…` : 'Ask Yaho to do something…'}
                  className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted/70"
                />
                {files.button}
                {busy ? (
                  <Button size="icon" variant="primary" onClick={() => running.current?.abort()} title="Stop">
                    <Square className="fill-current" />
                  </Button>
                ) : (
                  <Button size="icon" variant="primary" disabled={!text.trim() && !files.items.length} onClick={() => void send(text)} title="Send (Enter)">
                    <ArrowUp />
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-muted">
              Paste screenshots or attach files. Never paste secret values here; set them on the resource page.
            </p>
          </div>
        </>
      )}
    </aside>
  );
}

/** A pasted image as a data URL, scaled down to at most 1,600 pixels on its long side to keep requests small. */
function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('could not read the pasted image'));
    };
    img.src = src;
  });
}
