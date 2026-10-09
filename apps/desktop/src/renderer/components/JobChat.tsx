import { ArrowUp, ExternalLink, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type Job } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { Markdown } from './Markdown.tsx';
import { Button } from './ui/button.tsx';
import { money } from './ui/display.tsx';

type ThreadJob = Job & { texts: string[] };

const working = (j?: Job) => j?.status === 'running' || j?.status === 'queued';

/** Follow-ups on a job, in the chat panel: each one is a new job in the same session, so the agent remembers its work. */
export function JobChat({ job, onLeave }: { job: string; onLeave: () => void }) {
  const thread = useApi<ThreadJob[]>(
    `/api/jobs/${job}/thread`,
    (e) => e.type === 'job' || (e.type === 'job_event' && e.event.kind === 'text'),
  );
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const jobs = thread.data ?? [];
  const last = jobs.at(-1);
  const busy = sending || working(last);
  const textCount = jobs.reduce((n, j) => n + j.texts.length, 0);

  useEffect(() => {
    input.current?.focus();
  }, [job]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [jobs.length, textCount, busy]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy || !last) return;
    setError(null);
    setSending(true);
    try {
      await api(`/api/jobs/${last.id}/followup`, { body: { message } });
      setText('');
      thread.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  const first = jobs[0];
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line bg-panel/60 px-4 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted">
          Continuing <span className="font-medium text-ink">{first?.agent ?? '…'}</span> · <code>{job}</code>
        </span>
        <a href={href('jobs', last?.id ?? job)} title="Open the job" className="text-muted hover:text-ink">
          <ExternalLink className="size-3.5" />
        </a>
        <button type="button" onClick={onLeave} title="Back to Chat with Yaho" className="cursor-pointer text-muted hover:text-ink">
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {thread.error && <p className="text-sm text-danger">{thread.error}</p>}
        {jobs.map((j, i) => (
          <div key={j.id} className="space-y-2">
            {j.trigger_type === 'followup' ? (
              <div className="ml-8 rounded-xl bg-hover px-3 py-2 text-sm whitespace-pre-wrap">{j.trigger_detail}</div>
            ) : (
              <div className="text-xs text-muted">
                {i === 0 ? 'The job' : 'Resumed'} ({j.trigger_type}) · {money(j.cost_usd)}
              </div>
            )}
            {/* Its last word is the answer; earlier texts are progress notes (and agents often restate the answer after finishing). */}
            {j.texts.at(-1) && <Markdown className="text-sm">{j.texts.at(-1)!}</Markdown>}
            {working(j) && (
              <div className="flex items-center gap-2 text-sm text-muted">
                <span className="size-2 animate-pulse rounded-full bg-accent" /> {j.status === 'queued' ? 'Queued…' : 'Working…'}
              </div>
            )}
            {(j.status === 'failed' || j.status === 'budget_exhausted' || j.status === 'stopped') && (
              <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-xs text-danger">
                {j.status.replace('_', ' ')}
                {j.reason ? `: ${j.reason}` : ''}
              </div>
            )}
            {j.trigger_type === 'followup' && !working(j) && <div className="text-[11px] text-muted">{money(j.cost_usd)}</div>}
          </div>
        ))}
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
                void send();
              }
            }}
            placeholder={busy ? 'Wait for the agent to finish…' : `Ask ${first?.agent ?? 'the agent'} a follow-up…`}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted/70"
          />
          <Button size="icon" variant="primary" disabled={!text.trim() || busy} onClick={() => void send()} title="Send (Enter)">
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted">Each follow-up is a job that resumes the agent's session, within its budget.</p>
      </div>
    </>
  );
}
