import { Copy, ExternalLink, File, FileText, FolderOpen, Images, MoreHorizontal, Presentation, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useContextMenu } from '../components/ContextMenu.tsx';
import { Button } from '../components/ui/button.tsx';
import { Dialog } from '../components/ui/dialog.tsx';
import { cn } from '../components/ui/cn.ts';
import { ago, Badge, Card, Empty, ErrorNote, PageHeader } from '../components/ui/display.tsx';
import { Input, Select } from '../components/ui/form.tsx';
import { api, url, useApi, type Agent, type Artifact, type Project } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';

const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const isImage = (p: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext(p));
const isVideo = (p: string) => ['mp4', 'webm', 'mov'].includes(ext(p));
const isPdf = (p: string) => ext(p) === 'pdf';
const isSlides = (p: string) => ['ppt', 'pptx', 'key', 'odp'].includes(ext(p));
const isDocument = (p: string) => ['md', 'txt', 'doc', 'docx', 'odt', 'rtf', 'html', 'csv', 'xls', 'xlsx', 'json'].includes(ext(p));

/** The file types the gallery can filter on, in the order the chips show. */
const TYPES = [
  ['image', 'Images', isImage],
  ['video', 'Video', isVideo],
  ['pdf', 'PDF', isPdf],
  ['slides', 'Slides', isSlides],
  ['document', 'Documents', isDocument],
] as const;
type FileType = (typeof TYPES)[number][0] | 'other';
export const fileTypeOf = (p: string): FileType => TYPES.find(([, , test]) => test(p))?.[0] ?? 'other';

const fileUrl = (a: Artifact) => url(`/api/artifacts/${a.id}/file`);

function Preview({ a, large }: { a: Artifact; large?: boolean }) {
  const h = large ? 'h-[60vh]' : 'h-36';
  if (isImage(a.file_path))
    return <img src={fileUrl(a)} alt={a.file_path} className={cn('w-full bg-hover object-contain', h)} loading="lazy" />;
  if (isVideo(a.file_path))
    return <video src={fileUrl(a)} className={cn('w-full bg-black', h)} controls={large} muted preload="metadata" />;
  if (isPdf(a.file_path) && large) return <iframe src={fileUrl(a)} title={a.file_path} className={cn('w-full', h)} />;
  const Icon = isSlides(a.file_path) ? Presentation : isPdf(a.file_path) ? FileText : File;
  return (
    <div className={cn('flex w-full flex-col items-center justify-center gap-2 bg-hover text-muted', h)}>
      <Icon className="size-8" />
      <span className="text-xs uppercase">{ext(a.file_path)}</span>
    </div>
  );
}

export function ArtifactGrid({ artifacts, compact }: { artifacts: Artifact[]; compact?: boolean }) {
  const [open, setOpen] = useState<Artifact | null>(null);
  const [deleting, setDeleting] = useState<Artifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useContextMenu();
  const remove = async (a: Artifact) => {
    setDeleting(null);
    setError(null);
    try {
      await api(`/api/artifacts/${a.id}`, { method: 'DELETE' });
      if (open?.id === a.id) setOpen(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <ErrorNote>{error}</ErrorNote>
      <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(210px,1fr))]')}>
        {artifacts.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setOpen(a)}
            onContextMenu={(e) =>
              menu.open(e, [
                { label: 'Open', icon: <ExternalLink />, onSelect: () => setOpen(a) },
                { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(a) },
              ])
            }
            className="cursor-pointer text-left"
          >
            <Card className="overflow-hidden transition-colors hover:border-line-strong">
              <Preview a={a} />
              {!compact && (
                <div className="space-y-1 p-2.5">
                  <div className="truncate text-sm font-medium">{a.file_path}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <Badge>{a.kind}</Badge>
                    <span className="truncate">
                      {a.agent} · {ago(a.created)}
                    </span>
                  </div>
                </div>
              )}
            </Card>
          </button>
        ))}
      </div>
      {open && <ArtifactViewer a={open} onClose={() => setOpen(null)} onDelete={() => setDeleting(open)} />}
      {menu.element}
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.file_path}?`}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleting && void remove(deleting)}>
              Delete Artifact
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">The file is removed from the project for good. Messages that showed it no longer will.</p>
      </Dialog>
    </>
  );
}

function ArtifactViewer({ a, onClose, onDelete }: { a: Artifact; onClose: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyPath = async () => {
    const { path } = await api<{ path: string }>(`/api/artifacts/${a.id}/path`);
    await navigator.clipboard.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-medium">{a.file_path}</div>
            <div className="text-xs text-muted">
              <a className="hover:text-accent" href={href('projects', a.project)} onClick={onClose}>
                {a.project}
              </a>{' '}
              ·{' '}
              <a className="hover:text-accent" href={href('agents', a.agent)} onClick={onClose}>
                {a.agent}
              </a>
              {a.job && (
                <>
                  {' '}
                  ·{' '}
                  <a className="hover:text-accent" href={href('jobs', a.job)} onClick={onClose}>
                    {a.job}
                  </a>
                </>
              )}{' '}
              · {ago(a.created)}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => platform.openExternal(fileUrl(a))}>
              <ExternalLink /> Open
            </Button>
            <Button
              size="sm"
              onClick={async () =>
                platform.reveal(
                  (await api<{ path: string }>(`/api/artifacts/${a.id}/path`)).path,
                  url(`/api/artifacts/${a.id}/file`, { download: '1' }),
                )
              }
            >
              <FolderOpen /> {platform.kind === 'desktop' ? 'Show in Folder' : 'Download'}
            </Button>
            <Button size="sm" onClick={() => void copyPath()}>
              <Copy /> {copied ? 'Copied' : 'Copy Path'}
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete} title="Delete">
              <Trash2 />
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
        <Preview a={a} large />
      </Card>
    </div>
  );
}

export function ArtifactsView() {
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [job, setJob] = useState('');
  const q = new URLSearchParams({ ...(project && { project }), ...(agent && { agent }), ...(job && { job }) }).toString();
  const artifacts = useApi<Artifact[]>(`/api/artifacts?${q}`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  const projects = useApi<Project[]>('/api/projects');
  const agents = useApi<Agent[]>('/api/agents');
  const [type, setType] = useState<FileType | ''>('');
  const [kind, setKind] = useState('');
  const all = artifacts.data ?? [];
  const counts = new Map<FileType, number>();
  for (const a of all) counts.set(fileTypeOf(a.file_path), (counts.get(fileTypeOf(a.file_path)) ?? 0) + 1);
  const kinds = [...new Set(all.map((a) => a.kind))].sort();
  const shown = all.filter((a) => (!type || fileTypeOf(a.file_path) === type) && (!kind || a.kind === kind));
  const more = useContextMenu();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const filtered = !!(project || agent || job || type || kind);
  const deleteShown = async () => {
    setBusy(true);
    try {
      await api('/api/artifacts/delete', { body: { ids: shown.map((a) => a.id) } });
      setConfirmAll(false);
    } finally {
      setBusy(false);
    }
  };
  const chips: Array<[FileType | '', string, number]> = [
    ['', 'All', all.length],
    ...TYPES.map(([id, label]) => [id, label, counts.get(id) ?? 0] as [FileType, string, number]),
    ['other', 'Other', counts.get('other') ?? 0],
  ];
  return (
    <>
      <PageHeader
        title="Artifacts"
        sub="Everything agents have made, stored in their projects."
        actions={
          <>
            <Button
              size="icon"
              variant="ghost"
              title="More"
              disabled={!shown.length}
              onClick={(e) =>
                more.open(e, [
                  {
                    label: filtered ? `Delete These ${shown.length}` : `Delete All (${shown.length})`,
                    icon: <Trash2 />,
                    danger: true,
                    onSelect: () => setConfirmAll(true),
                  },
                ])
              }
            >
              <MoreHorizontal />
            </Button>
            {more.element}
            <Dialog
              open={confirmAll}
              onClose={() => setConfirmAll(false)}
              title={filtered ? `Delete these ${shown.length} artifacts?` : `Delete all ${shown.length} artifacts?`}
              footer={
                <>
                  <Button onClick={() => setConfirmAll(false)}>Cancel</Button>
                  <Button variant="danger" disabled={busy} onClick={() => void deleteShown()}>
                    Delete {shown.length}
                  </Button>
                </>
              }
            >
              <p className="text-sm text-muted">
                {filtered ? 'Only the artifacts the current filters show. ' : ''}Their files are removed from the projects for good.
              </p>
            </Dialog>
            <Select className="w-44" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All Projects</option>
              {projects.data?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.title}
                </option>
              ))}
            </Select>
            <Select className="w-40" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
              <option value="">All Agents</option>
              {agents.data?.map((a) => (
                <option key={a.name}>{a.name}</option>
              ))}
            </Select>
            <Input className="w-36" placeholder="Job id" value={job} onChange={(e) => setJob(e.target.value.trim())} aria-label="Job" />
          </>
        }
      />
      <div className="space-y-4 p-8">
        {all.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips
              .filter(([id, , n]) => id === '' || n > 0)
              .map(([id, label, n]) => (
                <button
                  key={id || 'all'}
                  type="button"
                  onClick={() => setType(id)}
                  className={cn(
                    'cursor-pointer rounded-md px-2.5 py-1 text-xs',
                    type === id ? 'bg-accent/12 font-medium text-accent' : 'text-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  {label} <span className="opacity-60">{n}</span>
                </button>
              ))}
            {kinds.length > 1 && (
              <Select className="ml-auto w-40" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
                <option value="">All kinds</option>
                {kinds.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            )}
          </div>
        )}
        {shown.length ? (
          <ArtifactGrid artifacts={shown} />
        ) : all.length ? (
          <div className="text-sm text-muted">Nothing of this type.</div>
        ) : (
          <Empty icon={<Images />} title="No artifacts">
            Agents register what they make with <code>yaho artifact add</code>.
          </Empty>
        )}
      </div>
    </>
  );
}
