import { Blocks, Check, ExternalLink, Link2, Loader2, Plus, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { ago, Badge, Card, Empty, ErrorNote, PageHeader, Tabs } from '../components/ui/display.tsx';
import { Field, Input } from '../components/ui/form.tsx';
import { api, useApi, type Resource } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { go, href } from '../lib/router.ts';

interface Toolkit {
  slug: string;
  name: string;
  logo: string;
  description: string;
  categories: string[];
  no_auth: boolean;
  managed_auth: boolean;
  tools_count: number;
}
interface Connection {
  id: string;
  status: string;
  toolkit: string;
  alias?: string | null;
  created_at: string;
  resources: string[];
}

const statusTone = (s: string) =>
  (s === 'ACTIVE' ? 'ok' : s === 'INITIATED' || s === 'INITIALIZING' ? 'info' : 'danger') as 'ok' | 'info' | 'danger';

export function AppLogo({ src, name, className }: { src?: string; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover text-sm font-semibold text-muted uppercase',
          className,
        )}
      >
        {name.slice(0, 1)}
      </span>
    );
  return (
    <img
      src={src}
      alt=""
      onError={() => setBroken(true)}
      className={cn('size-9 shrink-0 rounded-lg bg-white object-contain p-1', className)}
    />
  );
}

/** Browse Composio: your connections, and every app you could connect. Any active connection becomes a resource. */
export function ComposioExplorer() {
  const status = useApi<{ configured: boolean; user_id: string }>('/api/composio/status');
  const [tab, setTab] = useState<'connections' | 'apps'>('connections');
  const [adding, setAdding] = useState<{ id: string; toolkit: string } | null>(null);

  if (status.data && !status.data.configured)
    return (
      <>
        <PageHeader crumbs={[{ label: 'Resources', to: href('resources') }]} title="Add From Composio" />
        <Empty icon={<Blocks />} title="Composio is not set up">
          Add your Composio API key in{' '}
          <a className="text-accent underline" href={href('settings')}>
            Settings
          </a>{' '}
          to browse your connections and hundreds of apps.
        </Empty>
      </>
    );

  return (
    <>
      <div className="sticky top-0 z-20 bg-bg">
        <PageHeader
          crumbs={[{ label: 'Resources', to: href('resources') }]}
          title="Add From Composio"
          sub="Pick one of your connections, or connect a new app. Agents use it through YAHO; your Composio key never reaches them."
        />
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'connections', label: 'Your Connections' },
            { id: 'apps', label: 'All Apps' },
          ]}
        />
      </div>
      <div className="p-8">
        {tab === 'connections' ? <Connections onAdd={setAdding} onBrowse={() => setTab('apps')} /> : <Apps onAdd={setAdding} />}
      </div>
      <AddDialog connection={adding} onClose={() => setAdding(null)} />
    </>
  );
}

function Connections({ onAdd, onBrowse }: { onAdd: (c: { id: string; toolkit: string }) => void; onBrowse: () => void }) {
  const conns = useApi<Connection[]>('/api/composio/connections', (e) => e.type === 'changed' && e.entity === 'resources');
  const logos = useLogos(conns.data?.map((c) => c.toolkit) ?? []);
  const [query, setQuery] = useState('');
  if (conns.error) return <ErrorNote>{conns.error}</ErrorNote>;
  if (!conns.data) return <Loading />;
  if (!conns.data.length)
    return (
      <Empty icon={<Link2 />} title="No connections yet">
        <Button variant="primary" onClick={onBrowse}>
          Browse Apps
        </Button>
      </Empty>
    );
  const q = query.trim().toLowerCase();
  const shown = conns.data.filter((c) => !q || c.toolkit.includes(q) || c.alias?.toLowerCase().includes(q) || c.id.includes(q));
  return (
    <div className="space-y-3">
      <SearchBox value={query} onChange={setQuery} placeholder={`Search ${conns.data.length} connections…`} />
      <Card className="divide-y divide-line">
        {shown.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-3">
            <AppLogo src={logos[c.toolkit]?.logo} name={c.toolkit} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {logos[c.toolkit]?.name ?? c.toolkit}
                {c.alias && <span className="text-muted">· {c.alias}</span>}
                <Badge tone={statusTone(c.status)}>{c.status.toLowerCase()}</Badge>
              </div>
              <div className="text-xs text-muted">
                <code>{c.id}</code> · connected {ago(c.created_at)}
                {c.resources.length > 0 && <> · used by {c.resources.join(', ')}</>}
              </div>
            </div>
            <Button size="sm" disabled={c.status !== 'ACTIVE'} onClick={() => onAdd({ id: c.id, toolkit: c.toolkit })}>
              <Plus /> Add as Resource
            </Button>
          </div>
        ))}
        {!shown.length && <div className="p-4 text-sm text-muted">No matches.</div>}
      </Card>
    </div>
  );
}

/** Logos and names for toolkit slugs, looked up once each. */
function useLogos(slugs: string[]): Record<string, { logo: string; name: string }> {
  const [map, setMap] = useState<Record<string, { logo: string; name: string }>>({});
  const key = [...new Set(slugs)].sort().join(',');
  useEffect(() => {
    let alive = true;
    for (const slug of key.split(',').filter(Boolean)) {
      if (map[slug]) continue;
      api<{ items: Toolkit[] }>(`/api/composio/toolkits?search=${encodeURIComponent(slug)}`)
        .then((r) => {
          const t = r.items.find((x) => x.slug === slug);
          if (alive && t) setMap((m) => ({ ...m, [slug]: { logo: t.logo, name: t.name } }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

function Apps({ onAdd }: { onAdd: (c: { id: string; toolkit: string }) => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Toolkit[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ toolkit: Toolkit; id: string; url: string } | null>(null);
  const seq = useRef(0);

  const load = async (search: string, more?: string | null) => {
    const mine = ++seq.current;
    setError(null);
    try {
      const qs = new URLSearchParams({ ...(search && { search }), ...(more && { cursor: more }) }).toString();
      const r = await api<{ items: Toolkit[]; next_cursor: string | null }>(`/api/composio/toolkits?${qs}`);
      if (mine !== seq.current) return;
      setItems((prev) => (more ? [...(prev ?? []), ...r.items] : r.items));
      setCursor(r.next_cursor);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => void load(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const connect = async (t: Toolkit) => {
    setError(null);
    try {
      const r = await api<{ id: string; redirect_url: string }>('/api/composio/connect', { body: { toolkit: t.slug } });
      setConnecting({ toolkit: t, id: r.id, url: r.redirect_url });
      platform.openExternal(r.redirect_url);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <SearchBox value={query} onChange={setQuery} placeholder="Search apps: gmail, analytics, notion, hubspot…" />
      <ErrorNote>{error}</ErrorNote>
      {!items ? (
        <Loading />
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
          {items.map((t) => (
            <Card key={t.slug} className="flex flex-col gap-2 p-4">
              <div className="flex items-center gap-3">
                <AppLogo src={t.logo} name={t.name} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{t.name}</div>
                  <div className="truncate text-xs text-muted">{t.categories.slice(0, 2).join(' · ') || t.slug}</div>
                </div>
              </div>
              <p className="line-clamp-2 flex-1 text-sm text-muted">{t.description}</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">{t.tools_count} tools</span>
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => void connect(t)}
                  disabled={!t.managed_auth && !t.no_auth}
                  title={t.managed_auth || t.no_auth ? '' : 'Needs your own credentials; set it up in Composio first'}
                >
                  <Link2 /> Connect
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {items && !items.length && <div className="text-sm text-muted">No apps match.</div>}
      {cursor && (
        <div className="text-center">
          <Button onClick={() => void load(query.trim(), cursor)}>Load More</Button>
        </div>
      )}
      {connecting && (
        <ConnectWait
          toolkit={connecting.toolkit}
          id={connecting.id}
          url={connecting.url}
          onDone={() => {
            const c = connecting;
            setConnecting(null);
            onAdd({ id: c.id, toolkit: c.toolkit.slug });
          }}
          onClose={() => setConnecting(null)}
        />
      )}
    </div>
  );
}

/** Wait while the human signs in at Composio in their browser. */
function ConnectWait({
  toolkit,
  id,
  url,
  onDone,
  onClose,
}: {
  toolkit: Toolkit;
  id: string;
  url: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState('INITIATED');
  useEffect(() => {
    let alive = true;
    const end = Date.now() + 10 * 60_000;
    const poll = async () => {
      while (alive && Date.now() < end) {
        try {
          const c = await api<{ status: string }>(`/api/composio/connections/${id}`);
          if (!alive) return;
          setState(c.status);
          if (c.status === 'ACTIVE') return onDone();
          if (['FAILED', 'EXPIRED', 'REVOKED'].includes(c.status)) return;
        } catch {
          /* keep waiting */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [id, onDone]);
  const failed = ['FAILED', 'EXPIRED', 'REVOKED'].includes(state);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Connect ${toolkit.name}`}
      footer={<Button onClick={onClose}>{failed ? 'Close' : 'Cancel'}</Button>}
    >
      <div className="flex items-start gap-3 text-sm">
        <AppLogo src={toolkit.logo} name={toolkit.name} />
        <div className="space-y-2">
          {failed ? (
            <p className="text-danger">The connection {state.toLowerCase()}. Try again.</p>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-accent" /> Finish signing in to {toolkit.name} in your browser…
            </p>
          )}
          <Button size="sm" variant="ghost" onClick={() => platform.openExternal(url)}>
            <ExternalLink /> Open the Sign-In Page Again
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function AddDialog({ connection, onClose }: { connection: { id: string; toolkit: string } | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (connection) {
      setName(connection.toolkit.replace(/_/g, '-'));
      setError(null);
    }
  }, [connection]);
  if (!connection) return null;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<Resource>('/api/resources/composio', { body: { connected_account_id: connection.id, name } });
      onClose();
      go('resources', r.name);
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
      title="Add as Resource"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void add()}>
            <Check /> Add Resource
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Resource name" hint="How agents refer to it, e.g. yaho tools gmail.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <p className="text-xs text-muted">
          Connection <code>{connection.id}</code>. Grant it to agents on the resource page.
        </p>
      </div>
    </Dialog>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
      <Input className="pl-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 p-4 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" /> Loading from Composio…
    </div>
  );
}

/** The tools a Composio resource offers, searchable, with each input schema on click. */
export function ComposioTools({ toolkit }: { toolkit: string }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const tools = useApi<Array<{ slug: string; name: string; description: string; input_parameters: unknown }>>(
    `/api/composio/tools?toolkit=${encodeURIComponent(toolkit)}${debounced ? `&search=${encodeURIComponent(debounced)}` : ''}`,
  );
  return (
    <div className="space-y-3">
      <SearchBox value={query} onChange={setQuery} placeholder="Search tools…" />
      {tools.error && <ErrorNote>{tools.error}</ErrorNote>}
      <Card className="divide-y divide-line">
        {tools.data?.map((t) => (
          <div key={t.slug} className="px-4 py-2.5 text-sm">
            <button type="button" onClick={() => setOpen(open === t.slug ? null : t.slug)} className="w-full cursor-pointer text-left">
              <code className="text-[12.5px]">{t.slug}</code>
              <div className="line-clamp-2 text-xs text-muted">{t.description}</div>
            </button>
            {open === t.slug && (
              <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-code p-2 text-[12px]">
                {JSON.stringify(t.input_parameters, null, 2)}
              </pre>
            )}
          </div>
        ))}
        {!tools.data && !tools.error && <Loading />}
        {tools.data && !tools.data.length && <div className="p-4 text-sm text-muted">No tools match.</div>}
      </Card>
    </div>
  );
}
