import { Markdown } from '../components/Markdown.tsx';
import { DataTable, LayoutSwitch, useLayout } from '../components/ListLayout.tsx';
import { FileText, FolderKanban, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { ago, Badge, Card, Empty, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Textarea } from '../components/ui/form.tsx';
import { api, url, useApi, type Agent, type Artifact, type FileEntry, type Project } from '../lib/api.ts';
import { go, href } from '../lib/router.ts';
import { MultiPicker } from '../components/MultiPicker.tsx';
import { ArtifactGrid } from './artifacts.tsx';
import type { ViewProps } from './index.tsx';

const changed = (e: { type: string; entity?: string }) => e.type === 'changed' && (e.entity === 'projects' || e.entity === 'agents');

export function ProjectsView({ route }: ViewProps) {
  if (route[1] === 'new') return <ProjectForm />;
  if (route[1]) return <ProjectDetail name={route[1]} />;
  return <ProjectList />;
}

function ProjectList() {
  const projects = useApi<Project[]>('/api/projects', changed);
  const [layout, setLayout] = useLayout('projects');
  return (
    <>
      <PageHeader
        title="Projects"
        sub="What agents work on: a product, a campaign, a portfolio. Each holds a briefing, files and artifacts."
        actions={
          <>
            <LayoutSwitch value={layout} onChange={setLayout} />
            <Button variant="primary" onClick={() => go('projects', 'new')}>
              <Plus /> New Project
            </Button>
          </>
        }
      />
      {layout === 'table' && !!projects.data?.length && (
        <div className="p-8">
          <DataTable
            rows={projects.data}
            rowKey={(p) => p.name}
            to={(p) => ['projects', p.name]}
            columns={[
              { label: 'Project', cell: (p) => <span className="font-medium">{p.title}</span> },
              { label: 'Name', cell: (p) => <code className="text-xs text-muted">{p.name}</code> },
              { label: 'Briefing', cell: (p) => <span className="line-clamp-1 text-muted">{p.briefing || '—'}</span> },
              {
                label: 'Agents',
                cell: (p) => (
                  <span className="flex flex-wrap gap-1">
                    {p.agents.map((a) => (
                      <Badge key={a}>{a}</Badge>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
      <div className={cn('grid gap-3 p-8 md:grid-cols-2', layout === 'table' && 'hidden')}>
        {projects.data?.map((p) => (
          <a key={p.name} href={href('projects', p.name)}>
            <Card className="p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                <FolderKanban className="size-4 text-muted" />
                <span className="font-medium">{p.title}</span>
                <code className="text-xs text-muted">{p.name}</code>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted">{p.briefing || 'No briefing yet.'}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                {p.agents.map((a) => (
                  <Badge key={a}>{a}</Badge>
                ))}
              </div>
            </Card>
          </a>
        ))}
      </div>
      {projects.data?.length === 0 && <Empty icon={<FolderKanban />} title="No projects yet" />}
    </>
  );
}

function ProjectForm({ existing, onDone }: { existing?: Project; onDone?: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [briefing, setBriefing] = useState(existing?.briefing ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const body = { name, title: title || name, briefing };
      const p = existing
        ? await api<Project>(`/api/projects/${existing.name}`, { method: 'PUT', body })
        : await api<Project>('/api/projects', { body });
      onDone?.();
      go('projects', p.name);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const form = (
    <div className="max-w-2xl space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!existing)
                setName(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, ''),
                );
            }}
            placeholder="Widget Pro"
          />
        </Field>
        <Field label="Name" hint="Used in agent definitions and paths.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="widget-pro" />
        </Field>
      </div>
      <Field label="Briefing" hint="What every agent on this project should know.">
        <Textarea className="min-h-40" value={briefing} onChange={(e) => setBriefing(e.target.value)} />
      </Field>
      <Button variant="primary" onClick={() => void save()} disabled={!name}>
        {existing ? 'Save' : 'Create Project'}
      </Button>
    </div>
  );
  if (existing) return form;
  return (
    <>
      <PageHeader crumbs={[{ label: 'Projects', to: href('projects') }]} title="New Project" />
      <div className="p-8">{form}</div>
    </>
  );
}

function ProjectDetail({ name }: { name: string }) {
  const project = useApi<Project>(`/api/projects/${name}`, changed);
  const files = useApi<FileEntry[]>(`/api/projects/${name}/files`, changed);
  const artifacts = useApi<Artifact[]>(`/api/artifacts?project=${name}`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  const agents = useApi<Agent[]>('/api/agents', changed);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setEditing(false);
  }, [name]);

  const p = project.data;
  if (project.error) return <Empty title="Project not found">{project.error}</Empty>;
  if (!p) return null;

  const upload = async (list: FileList | null) => {
    setError(null);
    for (const f of Array.from(list ?? [])) {
      try {
        await api(`/api/projects/${name}/files?name=${encodeURIComponent(f.name)}`, { raw: f });
      } catch (e) {
        setError((e as Error).message);
      }
    }
    void files.reload();
  };
  const toggleAgent = async (agent: Agent) => {
    const on = agent.projects.includes(name);
    await api(`/api/agents/${agent.name}`, {
      method: 'PATCH',
      body: { projects: on ? agent.projects.filter((x) => x !== name) : [...agent.projects, name] },
    });
    void project.reload();
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Projects', to: href('projects') }]}
        title={p.title}
        sub={<code>{p.name}</code>}
        actions={
          <>
            <Button onClick={() => setEditing(!editing)}>{editing ? 'Cancel' : 'Edit'}</Button>
            <Button variant="danger" onClick={() => setDeleting(true)}>
              <Trash2 />
            </Button>
          </>
        }
      />
      <div className="space-y-8 p-8">
        <ErrorNote>{error}</ErrorNote>
        {editing ? (
          <ProjectForm existing={p} onDone={() => setEditing(false)} />
        ) : (
          <Section title="Briefing">
            <Card className="p-4 text-sm">
              {p.briefing ? <Markdown>{p.briefing}</Markdown> : <span className="text-muted">Empty</span>}
            </Card>
          </Section>
        )}

        <Section
          title="Context Files"
          actions={
            <Button size="sm" onClick={() => input.current?.click()}>
              <Upload /> Add Files
            </Button>
          }
        >
          <input ref={input} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <Card
            className={cn('divide-y divide-line', drag && 'border-accent bg-accent/5')}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void upload(e.dataTransfer.files);
            }}
          >
            {files.data
              ?.filter((f) => !f.dir)
              .map((f) => (
                <div key={f.path} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <FileText className="size-4 text-muted" />
                  <a
                    className="truncate hover:text-accent"
                    href={url(`/api/projects/${name}/files/${encodeURIComponent(f.path)}`)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {f.path}
                  </a>
                  <span className="ml-auto text-xs text-muted">
                    {(f.size / 1024).toFixed(1)} KB · {ago(f.modified)}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Remove"
                    onClick={async () => {
                      await api(`/api/projects/${name}/files/${encodeURIComponent(f.path)}`, { method: 'DELETE' });
                      void files.reload();
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            {!files.data?.some((f) => !f.dir) && (
              <div className="p-6 text-center text-sm text-muted">
                Drop files here to give agents working on this project more context: brand guides, specs, data.
              </div>
            )}
          </Card>
        </Section>

        <Section title="Agents">
          <MultiPicker
            noun="Agent"
            emptyText="No agents"
            options={agents.data?.map((a) => ({ value: a.name, hint: a.briefing.split('\n')[0] })) ?? []}
            value={agents.data?.filter((a) => a.projects.includes(name)).map((a) => a.name) ?? []}
            onChange={(next) => {
              for (const a of agents.data ?? []) {
                const on = a.projects.includes(name);
                if (on !== next.includes(a.name)) void toggleAgent(a);
              }
            }}
          />
        </Section>

        <Section title="Artifacts">
          {artifacts.data?.length ? <ArtifactGrid artifacts={artifacts.data} /> : <div className="text-sm text-muted">None yet.</div>}
        </Section>
      </div>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${p.title}?`}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/projects/${name}`, { method: 'DELETE' });
                go('projects');
              }}
            >
              Delete Project
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">This deletes the project's files and artifacts from disk. Agents lose access to it.</p>
      </Dialog>
    </>
  );
}
