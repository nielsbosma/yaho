import { GitCommitVertical, History, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { ago, Badge, Card, Empty, ErrorNote } from '../../components/ui/display.tsx';
import { api, useApi, type Agent } from '../../lib/api.ts';
import { go, href } from '../../lib/router.ts';
import { agentChanged } from './shared.ts';

interface Version {
  sha: string;
  date: string;
  author: string;
  subject: string;
  job: string | null;
  files: number;
}

interface VersionDetail extends Version {
  body: string;
  changes: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; additions: number | null; deletions: number | null }>;
  patch: string;
  truncated: boolean;
}

/** The git history of an agent's workspace and definition: what each job changed, with undo. */
export function AgentVersions({ agent, open }: { agent: Agent; open?: string }) {
  const base = `/api/agents/${encodeURIComponent(agent.name)}/versions`;
  const list = useApi<Version[]>(base, agentChanged(agent.name));
  const [error, setError] = useState<string | null>(null);
  if (list.error) return <Empty title="No versions">{list.error}</Empty>;
  if (!list.data) return null;
  if (!list.data.length)
    return (
      <Empty icon={<History />} title="No versions yet">
        Yaho saves a version of the workspace after each job.
      </Empty>
    );

  const act = async (sha: string, what: 'undo' | 'restore') => {
    const msg =
      what === 'undo'
        ? 'Put back the files this version changed as they were before it? Later edits to those files are lost.'
        : 'Put the whole workspace and definition back as they were at this version? Everything after it is undone (and stays in the history).';
    if (!confirm(msg)) return;
    setError(null);
    try {
      await api(`${base}/${sha}/${what}`, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <ErrorNote>{error}</ErrorNote>
      {list.data.map((v, i) => (
        <Card key={v.sha} className="p-3">
          <div className="flex items-center gap-2 text-sm">
            <GitCommitVertical className="size-4 shrink-0 text-muted" />
            <button
              type="button"
              className="min-w-0 cursor-pointer truncate text-left font-medium"
              onClick={() => go('agents', agent.name, 'versions', ...(open === v.sha ? [] : [v.sha]))}
            >
              {v.subject}
            </button>
            <span className="shrink-0 text-muted">
              {v.author} · {ago(v.date)} · {v.files} file{v.files === 1 ? '' : 's'}
            </span>
            {v.job && (
              <a className="shrink-0 font-mono text-xs text-muted hover:text-accent" href={href('jobs', v.job)}>
                {v.job}
              </a>
            )}
            <span className="ml-auto flex shrink-0 gap-1">
              {i === 0 && <Badge tone="ok">current</Badge>}
              <Button size="sm" variant="ghost" onClick={() => void act(v.sha, 'undo')} title="Undo just this version's changes">
                <Undo2 /> Undo
              </Button>
              {i > 0 && (
                <Button size="sm" variant="ghost" onClick={() => void act(v.sha, 'restore')} title="Go back to this version">
                  <History /> Restore
                </Button>
              )}
            </span>
          </div>
          {open === v.sha && <VersionDiff path={`${base}/${v.sha}`} />}
        </Card>
      ))}
    </div>
  );
}

export function VersionDiff({ path }: { path: string }) {
  const d = useApi<VersionDetail>(path);
  if (d.error) return <ErrorNote>{d.error}</ErrorNote>;
  if (!d.data) return null;
  const v = d.data;
  return (
    <div className="mt-3 space-y-3 border-t border-line pt-3">
      {v.body && <p className="text-sm whitespace-pre-wrap text-muted">{v.body}</p>}
      <ul className="space-y-0.5 text-sm">
        {v.changes.map((c) => (
          <li key={c.path} className="flex gap-2 font-mono text-xs">
            <span className={cn('w-16', c.status === 'added' ? 'text-ok' : c.status === 'deleted' ? 'text-danger' : 'text-muted')}>
              {c.status}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.path}</span>
            {c.additions !== null && (
              <span className="tabular-nums">
                <span className="text-ok">+{c.additions}</span> <span className="text-danger">-{c.deletions}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      <pre className="max-h-[32rem] overflow-auto rounded-lg bg-bg p-3 text-xs leading-relaxed">
        {v.patch.split('\n').map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith('+') && !line.startsWith('+++') && 'text-ok',
              line.startsWith('-') && !line.startsWith('---') && 'text-danger',
              (line.startsWith('diff ') || line.startsWith('@@')) && 'text-muted',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
      {v.truncated && <div className="text-xs text-muted">The diff is cut short here.</div>}
    </div>
  );
}
