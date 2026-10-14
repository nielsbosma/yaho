import { FileJson, Loader2, LogIn, LogOut, Play, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { Badge, Card, ErrorNote, PageHeader, Section, Tabs } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch, Textarea } from '../components/ui/form.tsx';
import { api, useApi, type McpConfig, type Resource } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { go, href } from '../lib/router.ts';

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  enabled: boolean;
}

interface McpStatus {
  ok: boolean;
  signed_in?: boolean;
  needs_auth?: boolean;
  error?: string;
  server?: { name: string; version?: string; title?: string } | null;
  instructions?: string | null;
  tools?: McpTool[];
  resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>;
  prompts?: Array<{ name: string; description?: string; arguments?: Array<{ name: string; required?: boolean }> }>;
  stderr?: string[];
}

const changed = (e: { type: string; entity?: string }) => e.type === 'changed' && e.entity === 'resources';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Where an MCP server is: its command or its address, as configured (keys as ${KEY}). */
export function mcpTarget(c?: McpConfig): string {
  if (!c) return '';
  return c.transport === 'stdio' ? [c.command, ...(c.args ?? [])].join(' ') : (c.url ?? '');
}

// ---------- adding a server ----------

export function McpNew() {
  const [tab, setTab] = useState<'custom' | 'import'>('custom');
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Resources', to: href('resources') }]}
        title="New MCP Server"
        sub="Agents get its tools as their own. Yaho connects to the server and makes every call, so its keys never reach an agent."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'custom', label: 'Custom' },
          { id: 'import', label: 'Import JSON' },
        ]}
      />
      <div className="p-8">
        {tab === 'custom' && <McpConfigForm />}
        {tab === 'import' && <ImportJson />}
      </div>
    </>
  );
}

type Pair = { k: string; v: string };
const pairs = (r?: Record<string, string>): Pair[] => Object.entries(r ?? {}).map(([k, v]) => ({ k, v }));
const record = (p: Pair[]) => Object.fromEntries(p.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v]));

function PairsInput({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  value: Pair[];
  onChange: (v: Pair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="space-y-2">
      {value.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="w-56 font-mono"
            value={p.k}
            placeholder={keyPlaceholder}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <Input
            className="font-mono"
            value={p.v}
            placeholder={valuePlaceholder}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <Button size="icon" variant="ghost" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...value, { k: '', v: '' }])}>
        <Plus /> Add
      </Button>
    </div>
  );
}

/** A server's config: new (with its keys' values), or the config of an existing resource. */
export function McpConfigForm({ existing, onDone }: { existing?: Resource; onDone?: () => void }) {
  const c = existing?.config?.mcp;
  const [name, setName] = useState(existing?.name ?? '');
  const [briefing, setBriefing] = useState(existing?.briefing ?? '');
  const [transport, setTransport] = useState<McpConfig['transport']>(c?.transport ?? 'stdio');
  const [command, setCommand] = useState(c?.command ?? '');
  const [args, setArgs] = useState((c?.args ?? []).join('\n'));
  const [env, setEnv] = useState<Pair[]>(pairs(c?.env));
  const [cwd, setCwd] = useState(c?.cwd ?? '');
  const [url, setUrl] = useState(c?.url ?? '');
  const [headers, setHeaders] = useState<Pair[]>(pairs(c?.headers));
  const [timeout, setTimeoutS] = useState(String(c?.timeout_s ?? ''));
  const [secrets, setSecrets] = useState<Pair[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const config = (): McpConfig => ({
    transport,
    ...(transport === 'stdio'
      ? {
          command: command.trim(),
          args: args
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean),
          env: record(env),
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        }
      : { url: url.trim(), headers: record(headers) }),
    ...(c?.tools ? { tools: c.tools } : {}),
    ...(Number(timeout) > 0 ? { timeout_s: Number(timeout) } : {}),
  });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api(`/api/resources/${encodeURIComponent(existing.name)}`, {
          method: 'PUT',
          body: { name: existing.name, briefing, kind: 'mcp', config: { ...existing.config, mcp: config() } },
        });
        onDone?.();
      } else {
        const r = await api<Resource>('/api/resources/mcp', {
          body: {
            name: slug(name),
            briefing,
            config: config(),
            keys: secrets.filter((s) => s.k.trim()).map((s) => ({ name: s.k.trim(), value: s.v, secret: true })),
          },
        });
        go('resources', r.name);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-4">
      <ErrorNote>{error}</ErrorNote>
      {!existing && (
        <Field label="Name" hint="Agents see its tools as <name>__<tool>.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </Field>
      )}
      <Field label="Briefing" hint="What it is for and when to use it. Agents read this.">
        <Textarea value={briefing} onChange={(e) => setBriefing(e.target.value)} />
      </Field>
      <Field label="Transport">
        <Select value={transport} onChange={(e) => setTransport(e.target.value as McpConfig['transport'])}>
          <option value="stdio">Local command (stdio)</option>
          <option value="http">Remote server (Streamable HTTP)</option>
          <option value="sse">Remote server (SSE, older servers)</option>
        </Select>
      </Field>
      {transport === 'stdio' ? (
        <>
          <Field label="Command" hint="Started by Yaho, on this machine (in the server version, as the agents' user).">
            <Input className="font-mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </Field>
          <Field label="Arguments" hint="One per line.">
            <Textarea
              className="font-mono"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder={'-y\n@modelcontextprotocol/server-everything'}
            />
          </Field>
          <Field label="Environment" group hint="Use ${KEY} for a key of this resource, e.g. API_KEY = ${API_KEY}.">
            <PairsInput value={env} onChange={setEnv} keyPlaceholder="API_KEY" valuePlaceholder="${API_KEY}" />
          </Field>
          <Field label="Working Folder" hint="Optional. By default a folder of its own in Yaho's data folder.">
            <Input className="font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <Input className="font-mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
          </Field>
          <Field
            label="Headers"
            group
            hint="E.g. Authorization = Bearer ${API_TOKEN}. Without an Authorization header, Yaho signs in with OAuth if the server asks."
          >
            <PairsInput value={headers} onChange={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer ${API_TOKEN}" />
          </Field>
        </>
      )}
      {!existing && (
        <Field label="Keys" group hint="Values for the ${KEY}s above. They go straight to Dopbase; agents never see them.">
          <PairsInput value={secrets} onChange={setSecrets} keyPlaceholder="API_TOKEN" valuePlaceholder="value" />
        </Field>
      )}
      <Field label="Tool Timeout" hint="Seconds a tool call may take. Default 120.">
        <Input className="w-32" value={timeout} onChange={(e) => setTimeoutS(e.target.value.replace(/[^0-9]/g, ''))} placeholder="120" />
      </Field>
      <Button
        variant="primary"
        disabled={busy || (!existing && !slug(name)) || (transport === 'stdio' ? !command.trim() : !url.trim())}
        onClick={() => void save()}
      >
        {existing ? 'Save' : 'Add MCP Server'}
      </Button>
    </div>
  );
}

function ImportJson() {
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<Resource[]>('/api/resources/mcp/import', { body: { json } });
      go('resources', ...(created.length === 1 ? [created[0]!.name] : []));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="max-w-3xl space-y-4">
      <ErrorNote>{error}</ErrorNote>
      <Field
        label="mcpServers JSON"
        hint="As in claude_desktop_config.json, Claude Code's .mcp.json, Cursor or VS Code. Each server becomes a resource; values in env and headers become secret keys in Dopbase."
      >
        <Textarea
          className="min-h-72 font-mono text-[12.5px]"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={
            '{\n  "mcpServers": {\n    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }\n  }\n}'
          }
        />
      </Field>
      <Button variant="primary" disabled={busy || !json.trim()} onClick={() => void run()}>
        <FileJson /> Import
      </Button>
    </div>
  );
}

// ---------- a server's page ----------

/** Connection, sign-in, tools (on or off for agents, and to try), documents and prompts of an MCP resource. */
export function McpServerPanel({ resource }: { resource: Resource }) {
  const name = resource.name;
  const status = useApi<McpStatus>(
    `/api/resources/${encodeURIComponent(name)}/mcp`,
    (e) => changed(e) && (e as { name?: string }).name === name,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trying, setTrying] = useState<McpTool | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const cfg = resource.config?.mcp;
  const s = status.data;
  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      await status.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const signIn = () =>
    act('sign-in', async () => {
      const r = await api<{ redirect_url?: string; connected?: boolean }>(`/api/resources/${encodeURIComponent(name)}/mcp/sign-in`, {
        body: {},
      });
      if (r.redirect_url) platform.openExternal(r.redirect_url);
    });
  const setTools = (tools: string[] | null) =>
    act('tools', () => api(`/api/resources/${encodeURIComponent(name)}/mcp/tools`, { method: 'PUT', body: { tools } }));
  const toggle = (t: McpTool, on: boolean) => {
    const all = s?.tools?.map((x) => x.name) ?? [];
    const enabled = new Set(s?.tools?.filter((x) => x.enabled).map((x) => x.name));
    if (on) enabled.add(t.name);
    else enabled.delete(t.name);
    void setTools(enabled.size === all.length ? null : all.filter((x) => enabled.has(x)));
  };
  const remote = cfg?.transport !== 'stdio';
  return (
    <div className="space-y-8">
      <Section
        title="Server"
        actions={
          <div className="flex gap-2">
            {remote &&
              (s?.signed_in ? (
                <Button
                  size="sm"
                  onClick={() => void act('sign-out', () => api(`/api/resources/${encodeURIComponent(name)}/mcp/sign-out`, { body: {} }))}
                >
                  <LogOut /> Sign Out
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant={s?.needs_auth ? 'primary' : 'secondary'}
                  disabled={busy === 'sign-in'}
                  onClick={() => void signIn()}
                >
                  <LogIn /> Sign In
                </Button>
              ))}
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() => void act('reconnect', () => api(`/api/resources/${encodeURIComponent(name)}/mcp/reconnect`, { body: {} }))}
            >
              <RefreshCw className={cn(busy === 'reconnect' && 'animate-spin')} /> Reconnect
            </Button>
          </div>
        }
      >
        <ErrorNote>{error}</ErrorNote>
        <Card className="space-y-2 p-4 text-sm">
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted" />
            <span className="font-medium">{s?.server?.title ?? s?.server?.name ?? cfg?.discovered?.server ?? name}</span>
            {s?.server?.version && <span className="text-xs text-muted">{s.server.version}</span>}
            <span className="ml-auto">
              {!s ? (
                <Loader2 className="size-4 animate-spin text-muted" />
              ) : s.ok ? (
                <Badge tone="ok">connected</Badge>
              ) : s.needs_auth ? (
                <Badge tone="warn">sign in needed</Badge>
              ) : (
                <Badge tone="danger">not connected</Badge>
              )}
            </span>
          </div>
          <div className="truncate font-mono text-xs text-muted" title={mcpTarget(cfg)}>
            {cfg?.transport} · {mcpTarget(cfg)}
          </div>
          {s && !s.ok && s.error && (
            <pre className="max-h-48 overflow-auto rounded-md bg-code p-2 text-[12px] whitespace-pre-wrap text-danger">{s.error}</pre>
          )}
          {s?.instructions && <p className="text-xs whitespace-pre-wrap text-muted">{s.instructions}</p>}
          {!!s?.stderr?.length && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted">Server log</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-code p-2 text-[12px]">{s.stderr.join('\n')}</pre>
            </details>
          )}
        </Card>
      </Section>

      {s?.ok && (
        <Section
          title={`Tools (${s.tools?.filter((t) => t.enabled).length ?? 0} of ${s.tools?.length ?? 0} on)`}
          actions={
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void setTools(null)}>
                All On
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void setTools(s.tools?.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name) ?? [])}
              >
                Read-Only
              </Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void setTools([])}>
                All Off
              </Button>
            </div>
          }
        >
          <Card className="divide-y divide-line">
            {s.tools?.map((t) => (
              <div key={t.name} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <Switch checked={t.enabled} onChange={(v) => toggle(t, v)} label={`Agents may use ${t.name}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-[12.5px]">{t.name}</code>
                    {t.annotations?.readOnlyHint && <Badge tone="neutral">read-only</Badge>}
                    {t.annotations?.destructiveHint && <Badge tone="warn">destructive</Badge>}
                  </div>
                  {t.description && <div className="line-clamp-2 text-xs text-muted">{t.description}</div>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => setTrying(t)}>
                  <Play /> Try
                </Button>
              </div>
            ))}
            {!s.tools?.length && <div className="p-4 text-sm text-muted">This server offers no tools.</div>}
          </Card>
        </Section>
      )}

      {!!s?.resources?.length && (
        <Section title="Documents">
          <Card className="divide-y divide-line">
            {s.resources.map((r) => (
              <div key={r.uri} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate">{r.name ?? r.uri}</div>
                  <code className="block truncate text-xs text-muted">{r.uri}</code>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setReading(r.uri)}>
                  Read
                </Button>
              </div>
            ))}
          </Card>
        </Section>
      )}

      {!!s?.prompts?.length && (
        <Section title="Prompts">
          <Card className="divide-y divide-line">
            {s.prompts.map((p) => (
              <div key={p.name} className="px-4 py-2.5 text-sm">
                <code className="text-[12.5px]">{p.name}</code>
                {p.arguments?.length ? (
                  <span className="ml-2 text-xs text-muted">({p.arguments.map((a) => a.name + (a.required ? '' : '?')).join(', ')})</span>
                ) : null}
                {p.description && <div className="text-xs text-muted">{p.description}</div>}
              </div>
            ))}
          </Card>
        </Section>
      )}
      {trying && <TryTool resource={name} tool={trying} onClose={() => setTrying(null)} />}
      {reading && <ReadDocument resource={name} uri={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

/** A starting point for a tool's arguments, from its input schema. */
function exampleArgs(schema: unknown): string {
  const props = (schema as { properties?: Record<string, { type?: string; default?: unknown }> })?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props))
    out[k] =
      p.default ??
      (p.type === 'number' || p.type === 'integer'
        ? 0
        : p.type === 'boolean'
          ? false
          : p.type === 'array'
            ? []
            : p.type === 'object'
              ? {}
              : '');
  return JSON.stringify(out, null, 2);
}

function TryTool({ resource, tool, onClose }: { resource: string; tool: McpTool; onClose: () => void }) {
  const [args, setArgs] = useState(() => exampleArgs(tool.inputSchema));
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = args.trim() ? JSON.parse(args) : {};
      const r = await api<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>(
        `/api/resources/${encodeURIComponent(resource)}/mcp/tools/${encodeURIComponent(tool.name)}`,
        { body },
      );
      const text = r.content?.every((c) => c.type === 'text') ? r.content.map((c) => c.text).join('\n') : JSON.stringify(r, null, 2);
      if (r.isError) setError(text);
      else setResult(text);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Try ${tool.name}`}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Run
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {tool.description && <p className="text-sm text-muted">{tool.description}</p>}
        {tool.annotations?.destructiveHint && <p className="text-sm text-warn">This tool may change or delete things for real.</p>}
        <Field label="Arguments (JSON)">
          <Textarea className="min-h-40 font-mono text-[12.5px]" value={args} onChange={(e) => setArgs(e.target.value)} />
        </Field>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Input schema</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-code p-2 text-[12px]">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
        <ErrorNote>{error}</ErrorNote>
        {result !== null && <pre className="max-h-80 overflow-auto rounded-md bg-code p-2 text-[12px] whitespace-pre-wrap">{result}</pre>}
      </div>
    </Dialog>
  );
}

function ReadDocument({ resource, uri, onClose }: { resource: string; uri: string; onClose: () => void }) {
  const doc = useApi<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>(
    `/api/resources/${encodeURIComponent(resource)}/mcp/read?uri=${encodeURIComponent(uri)}`,
  );
  return (
    <Dialog open onClose={onClose} title={uri} footer={<Button onClick={onClose}>Close</Button>}>
      <ErrorNote>{doc.error}</ErrorNote>
      {!doc.data && !doc.error && <Loader2 className="size-4 animate-spin text-muted" />}
      {doc.data?.contents.map((c, i) => (
        <pre key={i} className="max-h-96 overflow-auto rounded-md bg-code p-2 text-[12px] whitespace-pre-wrap">
          {c.text ?? `(${c.mimeType ?? 'binary'}, ${Math.round(((c.blob?.length ?? 0) * 3) / 4)} bytes)`}
        </pre>
      ))}
    </Dialog>
  );
}
