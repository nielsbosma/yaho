import { JobChat } from './JobChat.tsx';
import { Markdown } from './Markdown.tsx';
import { Resizer, usePanelWidth } from './Resizer.tsx';
import { ArrowUp, Check, ChevronRight, SquarePen, Sparkles, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { go } from '../lib/router.ts';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
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
  steps?: Step[];
}

/** A chat lasts as long as the panel is open: closing it (or Ctrl+J) discards the conversation. */
const empty = (): { history: ChatMessage[]; turns: Turn[] } => ({ history: [], turns: [] });

const label = (tool: string) => tool.replace(/_/g, ' ');

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const args = step.args as Record<string, unknown>;
  const subject = String(
    args.name ?? args.id ?? args.to ?? args.path ?? (typeof args.yaml === 'string' ? (/name:\s*(\S+)/.exec(args.yaml)?.[1] ?? '') : ''),
  );
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-ink">
        {step.ok ? <Check className="size-3.5 text-ok" /> : <XCircle className="size-3.5 text-danger" />}
        <span>{label(step.tool)}</span>
        {subject && <code className="text-ink/80">{subject}</code>}
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
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
  agent,
  onLeaveJob,
  onLeaveAgent,
}: {
  onClose: () => void;
  job: string | null;
  agent: string | null;
  onLeaveJob: () => void;
  onLeaveAgent: () => void;
}) {
  const [state, setState] = useState(empty);
  const [width, setWidth] = usePanelWidth('assistant', 400, 320, 760);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
  }, [agent]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [state.turns.length, busy]);

  const send = async (msg: string) => {
    const content = msg.trim();
    if (!content || busy) return;
    setError(null);
    setText('');
    const history: ChatMessage[] = [...state.history, { role: 'user', content }];
    const turns: Turn[] = [...state.turns, { role: 'user', text: content }];
    setState({ history, turns });
    setBusy(true);
    try {
      const r = await api<{ messages: ChatMessage[]; steps: Step[]; navigate?: string[] }>('/api/assistant', {
        body: { messages: history, focus: agent ? { agent } : undefined },
      });
      const answer = r.messages.at(-1)?.content ?? '';
      const next = { history: r.messages, turns: [...turns, { role: 'assistant' as const, text: answer, steps: r.steps }] };
      setState(next);
      if (r.navigate?.length) go(...r.navigate);
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
      <div className="flex h-14 items-center gap-2 border-b border-line px-4">
        <Sparkles className="size-4 text-accent" />
        <span className="font-serif text-lg">Chat with Yaho</span>
        <div className="ml-auto flex gap-1">
          <Button size="icon" variant="ghost" title="New Chat" onClick={() => {
            reset();
            onLeaveJob();
            onLeaveAgent();
          }}>
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
      {agent && (
        <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-4 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted">
            About <span className="font-medium text-ink">{agent}</span>
          </span>
          <button type="button" onClick={onLeaveAgent} title="Chat about anything" className="cursor-pointer text-muted hover:text-ink">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!state.turns.length && (
          <p className="text-sm text-muted">
            {agent
              ? `Ask about ${agent}: how it works, why it did something, what it costs. Or ask for a change, like a better briefing, another model or a schedule, and Yaho makes it.`
              : 'Ask for anything you can do in Yaho: create or change agents, projects and resources, run jobs, read your inbox, adjust settings.'}
          </p>
        )}
        {state.turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="ml-8 rounded-xl bg-hover px-3 py-2 text-sm whitespace-pre-wrap">
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
        <div className="flex items-end gap-2 rounded-xl border border-line bg-panel p-2 focus-within:border-accent/50">
          <textarea
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
            placeholder={agent ? `Ask about ${agent}…` : 'Ask Yaho to do something…'}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted/70"
          />
          <Button size="icon" variant="primary" disabled={!text.trim() || busy} onClick={() => void send(text)} title="Send (Enter)">
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted">Never paste secret values here; set them on the resource page.</p>
      </div>
        </>
      )}
    </aside>
  );
}
