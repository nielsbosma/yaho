import { Bot, Check, Clock, Code2, FolderKanban, Inbox, KeyRound, LibraryBig, Lock, Search, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Markdown } from '../components/Markdown.tsx';
import { Resizer, usePanelWidth } from '../components/Resizer.tsx';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Badge, Card, Empty, ErrorNote, money, PageHeader, Section } from '../components/ui/display.tsx';
import { Input } from '../components/ui/form.tsx';
import { api, useApi, type Agent } from '../lib/api.ts';
import { go, href } from '../lib/router.ts';
import type { ViewProps } from './index.tsx';

interface Example {
  name: string;
  about: string;
  category: string;
  tags: string[];
  yaml: string;
  briefing: string;
  models: string[];
  budget_usd?: number;
  triggers: Array<{ cron?: string; inbox?: boolean }>;
  projects: Array<{ name: string; exists: boolean }>;
  resources: Array<{ name: string; exists: boolean; keys: Array<{ name: string; secret: boolean }> }>;
  installed: boolean;
}

/** Browse the example agents, read what each does and needs, and install one. */
export function LibraryView({ route }: ViewProps) {
  const examples = useApi<Example[]>(
    '/api/examples',
    (e) => e.type === 'changed' && (e.entity === 'agents' || e.entity === 'projects' || e.entity === 'resources'),
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [listWidth, setListWidth] = usePanelWidth('library-list', 320, 240, 560);

  const all = examples.data ?? [];
  const categories = useMemo(() => [...new Set(all.map((e) => e.category))], [all]);
  const q = query.trim().toLowerCase();
  const shown = all.filter(
    (e) =>
      (!category || e.category === category) &&
      (!q ||
        e.name.includes(q) ||
        e.about.toLowerCase().includes(q) ||
        e.tags.some((t) => t.includes(q)) ||
        e.category.toLowerCase().includes(q)),
  );
  const selected = all.find((e) => e.name === route[1]) ?? shown[0] ?? null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Example Library"
        sub="Ready-made agents to start from. They install disabled, with the projects and resources they need."
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex shrink-0 flex-col border-r border-line" style={{ width: listWidth }}>
          <Resizer width={listWidth} onChange={setListWidth} side="right" initial={320} />
          <div className="space-y-2 border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
              <Input
                className="pl-9"
                placeholder={`Search ${all.length} examples…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {[null, ...categories].map((c) => (
                <button
                  key={c ?? 'all'}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    'cursor-pointer rounded-md px-2 py-0.5 text-xs',
                    category === c ? 'bg-accent/12 font-medium text-accent' : 'text-muted hover:bg-hover hover:text-ink',
                  )}
                >
                  {c ?? 'All'}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {categories
              .filter((c) => shown.some((e) => e.category === c))
              .map((c) => (
                <div key={c}>
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{c}</div>
                  {shown
                    .filter((e) => e.category === c)
                    .map((e) => (
                      <a
                        key={e.name}
                        href={href('library', e.name)}
                        className={cn('block px-4 py-2.5 transition-colors', selected?.name === e.name ? 'bg-hover' : 'hover:bg-hover/50')}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Bot className="size-4 shrink-0 text-muted" />
                          <span className="truncate">{e.name}</span>
                          {e.installed && (
                            <Badge tone="ok" className="ml-auto">
                              installed
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 pl-6 text-xs text-muted">{e.about}</p>
                      </a>
                    ))}
                </div>
              ))}
            {examples.data && !shown.length && <div className="p-4 text-sm text-muted">No examples match.</div>}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected ? <ExampleDetail key={selected.name} ex={selected} /> : <Empty icon={<LibraryBig />} title="No examples" />}
        </div>
      </div>
    </div>
  );
}

function ExampleDetail({ ex }: { ex: Example }) {
  const [showYaml, setShowYaml] = useState(false);
  const [name, setName] = useState(ex.installed ? `${ex.name}-2` : ex.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missingResources = ex.resources.filter((r) => !r.exists);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ agent: Agent }>(`/api/examples/${ex.name}/install`, { body: { name } });
      go('agents', r.agent.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-8">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge>{ex.category}</Badge>
          {ex.tags.map((t) => (
            <span key={t} className="text-xs text-muted">
              #{t}
            </span>
          ))}
        </div>
        <h2 className="font-serif text-[28px] leading-tight">{ex.name}</h2>
        <p className="text-[15px] text-ink/85">{ex.about}</p>
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex min-w-56 flex-1 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted">Install as</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Button variant="primary" size="lg" disabled={busy || !name.trim()} onClick={() => void install()}>
          <Check /> Install Agent
        </Button>
        {ex.installed && (
          <a href={href('agents', ex.name)} className="text-sm text-accent hover:underline">
            Open the installed {ex.name}
          </a>
        )}
        <div className="w-full">
          <ErrorNote>{error}</ErrorNote>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Fact icon={<Clock />} label="Runs">
          {ex.triggers.map((t) => (t.cron ? `cron ${t.cron}` : 'on inbox messages')).join(' · ') || 'manually'}
        </Fact>
        <Fact icon={<Bot />} label="Models">
          {ex.models.join(', ') || 'defaults'}
        </Fact>
        <Fact icon={<Wallet />} label="Budget">
          {ex.budget_usd !== undefined ? money(ex.budget_usd) : 'default'}
        </Fact>
      </div>

      {(ex.projects.length > 0 || ex.resources.length > 0) && (
        <Section title="What it needs">
          <Card className="divide-y divide-line">
            {ex.projects.map((p) => (
              <div key={p.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <FolderKanban className="size-4 text-muted" />
                <span>
                  Project <code>{p.name}</code>
                </span>
                <span className={cn('ml-auto text-xs', p.exists ? 'text-ok' : 'text-muted')}>
                  {p.exists ? 'you have it' : 'created on install'}
                </span>
              </div>
            ))}
            {ex.resources.map((r) => (
              <div key={r.name} className="space-y-1 px-4 py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <KeyRound className="size-4 text-muted" />
                  <span>
                    Resource <code>{r.name}</code>
                  </span>
                  <span className={cn('ml-auto text-xs', r.exists ? 'text-ok' : 'text-muted')}>
                    {r.exists ? 'you have it' : 'created on install'}
                  </span>
                </div>
                {r.keys.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pl-7">
                    {r.keys.map((k) => (
                      <span key={k.name} className="inline-flex items-center gap-1 rounded bg-code px-1.5 py-0.5 font-mono text-[11px]">
                        {k.secret && <Lock className="size-3 text-warn" />}
                        {k.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Card>
          {missingResources.length > 0 && (
            <p className="text-xs text-muted">After installing, set the key values on each resource page, then enable the agent.</p>
          )}
        </Section>
      )}

      <Section
        title="Briefing"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setShowYaml(!showYaml)}>
            <Code2 /> {showYaml ? 'Show Briefing' : 'Show YAML'}
          </Button>
        }
      >
        <Card className="p-5 text-sm">
          {showYaml ? <pre className="overflow-auto text-[12.5px] whitespace-pre-wrap">{ex.yaml}</pre> : <Markdown>{ex.briefing}</Markdown>}
        </Card>
      </Section>
      {ex.triggers.some((t) => t.inbox) && !ex.triggers.some((t) => t.cron) && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Inbox className="size-3.5" /> Works on request: start it with Run Now and say what you need, or send it a message.
        </p>
      )}
    </div>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm">{children}</div>
    </Card>
  );
}
