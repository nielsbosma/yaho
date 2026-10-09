import { Database, Download, FileCode, FileImage, FileText, ScrollText, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, url, useApi, type FileEntry } from '../lib/api.ts';
import { Markdown } from './Markdown.tsx';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';
import { ago, Card, Empty, ErrorNote } from './ui/display.tsx';
import { Dialog } from './ui/dialog.tsx';

type Kind = 'markdown' | 'json' | 'jsonl' | 'text' | 'sqlite' | 'image' | 'other';

const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
export function kindOf(path: string): Kind {
  const e = ext(path);
  if (['md', 'markdown'].includes(e)) return 'markdown';
  if (e === 'json') return 'json';
  if (e === 'jsonl' || e === 'ndjson') return 'jsonl';
  if (['db', 'sqlite', 'sqlite3'].includes(e)) return 'sqlite';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'image';
  if (
    [
      'txt',
      'log',
      'csv',
      'tsv',
      'yaml',
      'yml',
      'toml',
      'ini',
      'py',
      'js',
      'mjs',
      'ts',
      'sh',
      'ps1',
      'sql',
      'html',
      'css',
      'xml',
      'env',
      '',
    ].includes(e)
  )
    return 'text';
  return 'other';
}

const icons = {
  markdown: FileText,
  json: FileCode,
  jsonl: ScrollText,
  text: FileCode,
  sqlite: Database,
  image: FileImage,
  other: FileText,
};
const MAX_TEXT = 2 * 1024 * 1024;

/** Browse an agent's workspace: its memory, scripts, database and transcripts, viewed in place. */
export function WorkspaceBrowser({ agent }: { agent: string }) {
  const files = useApi<FileEntry[]>(
    `/api/agents/${agent}/workspace`,
    (e) => e.type === 'job' || (e.type === 'changed' && e.entity === 'workspace'),
  );
  const real = (files.data?.filter((f) => !f.dir) ?? []).filter((f) => !/-(wal|shm|journal)$/.test(f.path));
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = real.find((f) => f.path === selected) ?? null;

  useEffect(() => {
    if (files.data && !current && real[0]) setSelected(real.find((f) => kindOf(f.path) === 'markdown')?.path ?? real[0].path);
  }, [files.data, current, real]);

  if (files.data && !real.length)
    return <Empty title="Empty workspace">The agent's scripts, memory files, agent.db and transcripts appear here.</Empty>;

  return (
    <div className="flex min-h-[420px] gap-4">
      <Card className="w-72 shrink-0 self-start overflow-hidden">
        {real.map((f) => {
          const Icon = icons[kindOf(f.path)];
          return (
            <div
              key={f.path}
              className={cn(
                'group flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-0',
                selected === f.path ? 'bg-hover' : 'hover:bg-hover/50',
              )}
              onClick={() => setSelected(f.path)}
            >
              <Icon className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px]">{f.path}</div>
                <div className="text-[11px] text-muted">
                  {(f.size / 1024).toFixed(1)} KB · {ago(f.modified)}
                </div>
              </div>
              <button
                type="button"
                title={`Delete ${f.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting(f.path);
                }}
                className="cursor-pointer rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-danger/10 hover:text-danger focus:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          );
        })}
      </Card>
      <div className="min-w-0 flex-1 space-y-2">
        <ErrorNote>{error}</ErrorNote>
        {current && <FileView agent={agent} file={current} />}
      </div>
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting}?`}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const path = deleting!;
                setDeleting(null);
                setError(null);
                try {
                  await api(`/api/agents/${agent}/workspace/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
                  if (selected === path) setSelected(null);
                  void files.reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Delete File
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          The agent loses this file for good. Memory notes, scripts and its database are how it remembers between runs.
        </p>
      </Dialog>
    </div>
  );
}

function FileView({ agent, file }: { agent: string; file: FileEntry }) {
  const kind = kindOf(file.path);
  const src = url(`/api/agents/${agent}/workspace/file`, { path: file.path, v: file.modified });
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    setError(null);
    if (!['markdown', 'json', 'jsonl', 'text'].includes(kind)) return;
    if (file.size > MAX_TEXT) {
      setError('Too large to show here; download it instead.');
      return;
    }
    let alive = true;
    fetch(src)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => alive && setText(t))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [src, kind, file.size]);

  const header = (
    <div className="flex items-center gap-2 border-b border-line px-4 py-2">
      <code className="truncate text-[12.5px]">{file.path}</code>
      <a
        href={url(`/api/agents/${agent}/workspace/file`, { path: file.path, download: file.path.split('/').pop()! })}
        className="ml-auto"
        title="Download"
      >
        <Button size="sm" variant="ghost">
          <Download /> Download
        </Button>
      </a>
    </div>
  );

  let body: React.ReactNode = null;
  if (error) body = <div className="p-4 text-sm text-muted">{error}</div>;
  else if (kind === 'sqlite') body = <SqliteView agent={agent} path={file.path} />;
  else if (kind === 'image') body = <img src={src} alt={file.path} className="max-h-[70vh] w-full object-contain p-4" />;
  else if (kind === 'other') body = <div className="p-4 text-sm text-muted">No preview for this kind of file.</div>;
  else if (text === null) body = <div className="p-4 text-sm text-muted">Loading…</div>;
  else if (kind === 'markdown') body = <Markdown className="p-5 text-sm">{text}</Markdown>;
  else if (kind === 'json') body = <pre className="overflow-auto p-4 text-[12.5px]">{pretty(text)}</pre>;
  else if (kind === 'jsonl') body = <Transcript text={text} />;
  else body = <pre className="overflow-auto p-4 text-[12.5px] whitespace-pre-wrap">{text}</pre>;

  return (
    <Card className="overflow-hidden">
      {header}
      {body}
    </Card>
  );
}

function pretty(t: string): string {
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return t;
  }
}

/** A harness transcript: one JSON event per line, summarised; click a row for the raw event. */
function Transcript({ text }: { text: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const lines = text.split('\n').filter((l) => l.trim());
  return (
    <div className="max-h-[70vh] divide-y divide-line overflow-auto text-[12.5px]">
      {lines.map((l, i) => {
        let e: Record<string, unknown> = {};
        try {
          e = JSON.parse(l);
        } catch {
          /* show raw */
        }
        return (
          <div key={i} className="px-4 py-1.5">
            <button type="button" onClick={() => setOpen(open === i ? null : i)} className="flex w-full cursor-pointer gap-3 text-left">
              <span className="w-24 shrink-0 text-muted">{String(e.type ?? 'line')}</span>
              <span className="truncate">{summarise(e) || l.slice(0, 160)}</span>
            </button>
            {open === i && <pre className="mt-1 overflow-auto rounded-md bg-code p-2 whitespace-pre-wrap">{pretty(l)}</pre>}
          </div>
        );
      })}
    </div>
  );
}

function summarise(e: Record<string, unknown>): string {
  const content = ((e.message as { content?: unknown[] })?.content ?? []) as Array<Record<string, unknown>>;
  const parts = content.map((c) => {
    if (c.type === 'text') return String(c.text ?? '');
    if (c.type === 'tool_use') return `→ ${String(c.name)} ${JSON.stringify(c.input).slice(0, 120)}`;
    if (c.type === 'tool_result') return `← ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}`.slice(0, 160);
    if (c.type === 'thinking') return '(thinking)';
    return '';
  });
  if (e.type === 'result')
    return `${String(e.subtype ?? '')} · $${Number(e.total_cost_usd ?? 0).toFixed(4)} · ${String(e.result ?? '').slice(0, 120)}`;
  if (e.type === 'system') return `${String(e.subtype ?? '')} ${String(e.session_id ?? '')}`;
  return parts.filter(Boolean).join(' · ');
}

interface TableInfo {
  name: string;
  rows: number;
  columns: Array<{ name: string; type: string }>;
}

/** Read-only: the tables, then the first rows of the chosen one. */
function SqliteView({ agent, path }: { agent: string; path: string }) {
  const base = `/api/agents/${agent}/workspace/sqlite?path=${encodeURIComponent(path)}`;
  const tables = useApi<TableInfo[]>(base);
  const [table, setTable] = useState<string | null>(null);
  const active = table ?? tables.data?.[0]?.name ?? null;
  const rows = useApi<Array<Record<string, unknown>>>(active ? `${base}&table=${encodeURIComponent(active)}` : null);
  if (tables.error) return <div className="p-4 text-sm text-danger">{tables.error}</div>;
  if (tables.data && !tables.data.length) return <div className="p-4 text-sm text-muted">No tables yet.</div>;
  const info = tables.data?.find((t) => t.name === active);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2">
        {tables.data?.map((t) => (
          <button
            key={t.name}
            type="button"
            onClick={() => setTable(t.name)}
            className={cn(
              'cursor-pointer rounded-md border px-2 py-0.5 text-xs',
              t.name === active ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:border-line-strong',
            )}
          >
            {t.name} <span className="opacity-60">{t.rows}</span>
          </button>
        ))}
      </div>
      {info && rows.data && (
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-panel text-left text-muted">
              <tr className="border-b border-line">
                {info.columns.map((c) => (
                  <th key={c.name} className="px-3 py-1.5 font-medium whitespace-nowrap">
                    {c.name} <span className="font-normal opacity-60">{c.type.toLowerCase()}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.data.map((r, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {info.columns.map((c) => (
                    <td key={c.name} className="max-w-80 truncate px-3 py-1 align-top font-mono" title={String(r[c.name] ?? '')}>
                      {r[c.name] === null ? <span className="text-muted">null</span> : String(r[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {info.rows > rows.data.length && (
            <div className="px-3 py-2 text-xs text-muted">
              Showing the first {rows.data.length} of {info.rows} rows.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
