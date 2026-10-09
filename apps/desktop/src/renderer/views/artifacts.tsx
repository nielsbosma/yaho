import { Copy, ExternalLink, File, FileText, FolderOpen, Images, Presentation } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { ago, Badge, Card, Empty, PageHeader } from '../components/ui/display.tsx';
import { api, url, useApi, type Agent, type Artifact, type Project } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';
import type { ViewProps } from './index.tsx';

const ext = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const isImage = (p: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext(p));
const isVideo = (p: string) => ['mp4', 'webm', 'mov'].includes(ext(p));
const isPdf = (p: string) => ext(p) === 'pdf';
const isSlides = (p: string) => ['ppt', 'pptx', 'key', 'odp'].includes(ext(p));

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
  return (
    <>
      <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(210px,1fr))]')}>
        {artifacts.map((a) => (
          <button key={a.id} type="button" onClick={() => setOpen(a)} className="cursor-pointer text-left">
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
      {open && <ArtifactViewer a={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function ArtifactViewer({ a, onClose }: { a: Artifact; onClose: () => void }) {
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
              <FolderOpen /> {platform.kind === 'desktop' ? 'Show in folder' : 'Download'}
            </Button>
            <Button size="sm" onClick={() => void copyPath()}>
              <Copy /> {copied ? 'Copied' : 'Copy path'}
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

export function ArtifactsView(_: ViewProps) {
  const [project, setProject] = useState('');
  const [agent, setAgent] = useState('');
  const [job, setJob] = useState('');
  const q = new URLSearchParams({ ...(project && { project }), ...(agent && { agent }), ...(job && { job }) }).toString();
  const artifacts = useApi<Artifact[]>(`/api/artifacts?${q}`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  const projects = useApi<Project[]>('/api/projects');
  const agents = useApi<Agent[]>('/api/agents');
  const select = 'h-8 rounded-lg border border-line bg-panel px-2 text-sm';
  return (
    <>
      <PageHeader
        title="Artifacts"
        sub="Everything agents have made, stored in their projects."
        actions={
          <>
            <select className={select} value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
              <option value="">All projects</option>
              {projects.data?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.title}
                </option>
              ))}
            </select>
            <select className={select} value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent">
              <option value="">All agents</option>
              {agents.data?.map((a) => (
                <option key={a.name}>{a.name}</option>
              ))}
            </select>
            <input
              className={cn(select, 'w-36')}
              placeholder="Job id"
              value={job}
              onChange={(e) => setJob(e.target.value.trim())}
              aria-label="Job"
            />
          </>
        }
      />
      <div className="p-8">
        {artifacts.data?.length ? (
          <ArtifactGrid artifacts={artifacts.data} />
        ) : (
          <Empty icon={<Images />} title="No artifacts">
            Agents register what they make with <code>yaho artifact add</code>.
          </Empty>
        )}
      </div>
    </>
  );
}
