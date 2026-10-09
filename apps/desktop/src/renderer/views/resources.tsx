import { Markdown } from '../components/Markdown.tsx';
import { useConfirmDelete } from '../components/ConfirmDelete.tsx';
import { useContextMenu } from '../components/ContextMenu.tsx';
import { DataTable, LayoutSwitch, openDeleteMenu, useLayout } from '../components/ListLayout.tsx';
import { MultiPicker } from '../components/MultiPicker.tsx';
import { AppLogo, ComposioExplorer, ComposioTools } from './composio.tsx';
import { Blocks, KeyRound, Lock, Plus, Trash2, Unlock } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { Badge, Card, Empty, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Switch, Textarea } from '../components/ui/form.tsx';
import { api, useApi, type Agent, type Resource } from '../lib/api.ts';
import { go, href } from '../lib/router.ts';
import type { ViewProps } from './index.tsx';

const changed = (e: { type: string; entity?: string }) => e.type === 'changed' && (e.entity === 'resources' || e.entity === 'agents');

export function ResourcesView({ route }: ViewProps) {
  if (route[1] === 'new') return <ResourceEditor />;
  if (route[1] === 'composio') return <ComposioExplorer />;
  if (route[1]) return <ResourceDetail name={route[1]} />;
  return <ResourceList />;
}

function ResourceList() {
  const list = useApi<Resource[]>('/api/resources', changed);
  const del = useConfirmDelete(
    'Resource',
    (name) => api(`/api/resources/${name}`, { method: 'DELETE' }),
    'Agents lose access. Values stay in Dopbase until you remove them there; a Composio connection stays in Composio.',
  );
  const cardMenu = useContextMenu();
  const rowMenu = (name: string) =>
    openDeleteMenu(
      () => go('resources', name),
      () => del.ask(name),
    );
  const [layout, setLayout] = useLayout('resources');
  return (
    <>
      <PageHeader
        title="Resources"
        sub="APIs, CLIs and accounts agents may use. Key values live in Dopbase; agents only ever see the names."
        actions={
          <>
            <LayoutSwitch value={layout} onChange={setLayout} />
            <Button onClick={() => go('resources', 'composio')}>
              <Blocks /> From Composio
            </Button>
            <Button variant="primary" onClick={() => go('resources', 'new')}>
              <Plus /> New Resource
            </Button>
          </>
        }
      />
      {layout === 'table' && !!list.data?.length && (
        <div className="p-8">
          <DataTable
            rows={list.data}
            menu={(r) => rowMenu(r.name)}
            rowKey={(r) => r.name}
            to={(r) => ['resources', r.name]}
            columns={[
              { label: 'Resource', cell: (r) => <span className="font-medium">{r.name}</span> },
              { label: 'Briefing', cell: (r) => <span className="line-clamp-1 text-muted">{r.briefing || '—'}</span> },
              {
                label: 'Keys',
                cell: (r) =>
                  r.kind === 'composio' ? (
                    <span className="flex items-center gap-1.5 text-muted">
                      <AppLogo src={r.config?.logo} name={r.config?.toolkit_name ?? r.name} className="size-5 rounded p-0.5" />
                      Composio
                    </span>
                  ) : (
                    <span className="text-muted">
                      {r.keys.length} ({r.keys.filter((k) => k.has_value).length} set)
                    </span>
                  ),
              },
              {
                label: 'Agents',
                cell: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.agents.map((a) => (
                      <Badge key={a}>{a}</Badge>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}
      {del.dialog}
      {cardMenu.element}
      <div className={cn('grid gap-3 p-8 md:grid-cols-2', layout === 'table' && 'hidden')}>
        {list.data?.map((r) => (
          <a key={r.name} href={href('resources', r.name)} onContextMenu={(e) => cardMenu.open(e, rowMenu(r.name))}>
            <Card className="p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 text-muted" />
                <span className="font-medium">{r.name}</span>
                <span className="ml-auto text-xs text-muted">{r.keys.length} keys</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted">{r.briefing || 'No briefing yet.'}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                {r.agents.map((a) => (
                  <Badge key={a}>{a}</Badge>
                ))}
              </div>
            </Card>
          </a>
        ))}
      </div>
      {list.data?.length === 0 && <Empty icon={<KeyRound />} title="No resources yet" />}
    </>
  );
}

function ResourceEditor({ existing, onDone }: { existing?: Resource; onDone?: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [briefing, setBriefing] = useState(existing?.briefing ?? '');
  const [keys, setKeys] = useState(existing?.keys.map((k) => ({ name: k.name, secret: k.secret })) ?? [{ name: '', secret: true }]);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const body = { name, briefing, keys: keys.filter((k) => k.name.trim()).map((k) => ({ ...k, name: k.name.trim() })) };
      const r = existing
        ? await api<Resource>(`/api/resources/${existing.name}`, { method: 'PUT', body })
        : await api<Resource>('/api/resources', { body });
      onDone?.();
      go('resources', r.name);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const form = (
    <div className="max-w-2xl space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="google-ads" />
      </Field>
      <Field label="Briefing" hint="What it is and how to use it. Agents read this.">
        <Textarea value={briefing} onChange={(e) => setBriefing(e.target.value)} />
      </Field>
      <Field label="Keys" hint="Environment variable names. Secret keys are never shown to agents; values are set on the resource page.">
        <div className="space-y-2">
          {keys.map((k, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="font-mono"
                value={k.name}
                placeholder="API_TOKEN"
                onChange={(e) =>
                  setKeys(keys.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))
                }
              />
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <Switch
                  checked={k.secret}
                  onChange={(v) => setKeys(keys.map((x, j) => (j === i ? { ...x, secret: v } : x)))}
                  label="Secret"
                />
                secret
              </label>
              <Button size="icon" variant="ghost" onClick={() => setKeys(keys.filter((_, j) => j !== i))} title="Remove key">
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setKeys([...keys, { name: '', secret: true }])}>
            <Plus /> Add Key
          </Button>
        </div>
      </Field>
      <Button variant="primary" onClick={() => void save()} disabled={!name}>
        {existing ? 'Save' : 'Create Resource'}
      </Button>
    </div>
  );
  if (existing) return form;
  return (
    <>
      <PageHeader crumbs={[{ label: 'Resources', to: href('resources') }]} title="New Resource" />
      <div className="p-8">{form}</div>
    </>
  );
}

function ResourceDetail({ name }: { name: string }) {
  const res = useApi<Resource>(`/api/resources/${name}`, changed);
  const agents = useApi<Agent[]>('/api/agents', changed);
  const [editing, setEditing] = useState(false);
  const [setting, setSetting] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const r = res.data;
  if (res.error) return <Empty title="Resource not found">{res.error}</Empty>;
  if (!r) return null;

  const toggleAgent = async (agent: Agent) => {
    const on = agent.resources.includes(name);
    await api(`/api/agents/${agent.name}`, {
      method: 'PATCH',
      body: { resources: on ? agent.resources.filter((x) => x !== name) : [...agent.resources, name] },
    });
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Resources', to: href('resources') }]}
        title={r.name}
        sub={
          r.kind === 'composio'
            ? `${r.config?.toolkit_name ?? r.config?.toolkit} through Composio. Agents use it with yaho tools / yaho tool; Yaho makes the calls.`
            : "Values are stored in Dopbase and injected into the agent's environment at job start."
        }
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
          <ResourceEditor existing={r} onDone={() => setEditing(false)} />
        ) : (
          <>
            <Section title="Briefing">
              <Card className="p-4 text-sm">
                {r.briefing ? <Markdown>{r.briefing}</Markdown> : <span className="text-muted">Empty</span>}
              </Card>
            </Section>
            {r.kind === 'composio' ? (
              <>
                <Section title="Connection">
                  <ComposioConnection resource={r} />
                </Section>
                <Section title="Tools">
                  <ComposioTools toolkit={r.config?.toolkit ?? ''} />
                </Section>
              </>
            ) : (
              <Section title="Keys">
                <Card className="divide-y divide-line">
                  {r.keys.map((k) => (
                    <div key={k.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      {k.secret ? <Lock className="size-4 text-warn" /> : <Unlock className="size-4 text-muted" />}
                      <code>{k.name}</code>
                      <Badge tone={k.secret ? 'warn' : 'neutral'}>{k.secret ? 'secret' : 'visible to agents'}</Badge>
                      <span className={cn('ml-auto text-xs', k.has_value ? 'text-ok' : 'text-muted')}>
                        {k.has_value ? 'value set' : 'no value'}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => {
                          setValue('');
                          setSetting(k.name);
                        }}
                      >
                        Set Value
                      </Button>
                    </div>
                  ))}
                  {!r.keys.length && <div className="p-4 text-sm text-muted">No keys. Edit the resource to add some.</div>}
                </Card>
              </Section>
            )}
          </>
        )}
        <Section title="Agents With Access">
          <MultiPicker
            noun="Agent"
            emptyText="No agents"
            options={agents.data?.map((a) => ({ value: a.name, hint: a.briefing.split('\n')[0] })) ?? []}
            value={agents.data?.filter((a) => a.resources.includes(name)).map((a) => a.name) ?? []}
            onChange={(next) => {
              for (const a of agents.data ?? []) {
                const on = a.resources.includes(name);
                if (on !== next.includes(a.name)) void toggleAgent(a);
              }
            }}
          />
        </Section>
      </div>
      <Dialog
        open={!!setting}
        onClose={() => setSetting(null)}
        title={`Set ${setting}`}
        footer={
          <>
            <Button onClick={() => setSetting(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!value}
              onClick={async () => {
                setError(null);
                try {
                  await api(`/api/resources/${name}/keys/${setting}/value`, { method: 'PUT', body: { value } });
                  setSetting(null);
                  setValue('');
                } catch (e) {
                  setError((e as Error).message);
                  setSetting(null);
                }
              }}
            >
              Save to Dopbase
            </Button>
          </>
        }
      >
        <Field label="Value" hint="Sent straight to Dopbase. Yaho does not store it and cannot show it again.">
          <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
      </Dialog>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${name}?`}
        footer={
          <>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/resources/${name}`, { method: 'DELETE' });
                go('resources');
              }}
            >
              Delete Resource
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">Agents lose access. The values stay in Dopbase until you remove them there.</p>
      </Dialog>
    </>
  );
}

/** The Composio connected account behind a resource, with its live status. */
function ComposioConnection({ resource }: { resource: Resource }) {
  const id = resource.config?.connected_account_id ?? '';
  const conn = useApi<{ status: string; created_at: string }>(id ? `/api/composio/connections/${id}` : null);
  return (
    <Card className="flex items-center gap-3 p-4 text-sm">
      <AppLogo src={resource.config?.logo} name={resource.config?.toolkit_name ?? resource.name} />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{resource.config?.toolkit_name ?? resource.config?.toolkit}</div>
        <div className="text-xs text-muted">
          <code>{id}</code>
        </div>
      </div>
      {conn.error ? (
        <span className="text-xs text-danger">{conn.error}</span>
      ) : conn.data ? (
        <Badge tone={conn.data.status === 'ACTIVE' ? 'ok' : 'danger'}>{conn.data.status.toLowerCase()}</Badge>
      ) : null}
    </Card>
  );
}
