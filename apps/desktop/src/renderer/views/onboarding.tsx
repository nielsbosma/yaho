import { ArrowLeft, ArrowRight, Check, Cpu, Loader2, X } from 'lucide-react';
import { BRAND_LOGOS, BrandLogo } from '../components/BrandLogo.tsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Wordmark } from '../components/Wordmark.tsx';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { ErrorNote } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch } from '../components/ui/form.tsx';
import { api, useApi } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';

/** The parts of the settings the setup touches. Secret fields are only sent, never read back. */
interface SetupSettings {
  providers: Array<{ id: string; kind: string; url?: string; api_key?: string }>;
  default_provider?: string;
  dopbase: { mode: string };
  global_spend_cap_usd: number;
  defaults: { models: string[]; budget_usd: number };
  assistant?: { model?: string };
  composio?: { api_key?: string };
  secrets_set?: Record<string, boolean>;
}

interface ProviderInfo {
  kind: string;
  label: string;
  available: boolean;
  description: string;
}

export interface ClaudeCheck {
  checked_at: string;
  installed: boolean;
  version?: string;
  recent?: boolean;
  works?: boolean;
  model?: string;
  error?: string;
  failed?: 'install' | 'version' | 'provider' | 'harness';
}


const STEPS = ['Welcome', 'Models', 'Claude Code', 'Budget', 'Connections', 'Finish'] as const;

/** Send changed settings; secret fields that are not given keep their stored value. */
async function save(patch: (s: SetupSettings) => void): Promise<void> {
  const s = await api<SetupSettings>('/api/settings');
  patch(s);
  await api('/api/settings', { method: 'PUT', body: s });
}

/**
 * The first-run setup: one step per screen, Back and Skip, each step writing through the normal settings API. Shown
 * until it is finished or skipped, and again from Settings → Run Setup Again.
 */
export function Onboarding({ onDone }: { onDone?: () => void }) {
  const [step, setStep] = useState(0);
  const settings = useApi<SetupSettings>('/api/settings');
  const finish = async () => {
    await api('/api/onboarding/done', { method: 'POST' });
    onDone?.();
  };
  const next = () => setStep((n) => Math.min(STEPS.length - 1, n + 1));
  const back = () => setStep((n) => Math.max(0, n - 1));
  const s = settings.data;

  return (
    <div className="app-drag flex h-full flex-col items-center overflow-y-auto bg-sidebar px-4 pt-14 pb-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 flex items-center justify-between">
          <Wordmark className="h-8" />
          <button type="button" onClick={() => void finish()} className="cursor-pointer text-xs text-muted hover:text-ink">
            Skip Setup
          </button>
        </div>
        <ol className="mb-6 flex gap-1.5" aria-label="Setup steps">
          {STEPS.map((title, i) => (
            <li key={title} title={title} className={cn('h-1 flex-1 rounded-full', i <= step ? 'bg-accent' : 'bg-line')} />
          ))}
        </ol>
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
          <div className="mb-1 text-xs font-medium text-muted">
            Step {step + 1} of {STEPS.length}
          </div>
          <h1 className="mb-4 font-serif text-2xl">{STEPS[step]}</h1>
          {!s ? (
            <Loader2 className="size-5 animate-spin text-muted" />
          ) : (
            <>
              {step === 0 && <Welcome />}
              {step === 1 && <ModelsStep settings={s} />}
              {step === 2 && <ClaudeStep />}
              {step === 3 && <BudgetStep settings={s} />}
              {step === 4 && <ConnectionsStep settings={s} />}
              {step === 5 && <FinishStep />}
            </>
          )}
          <div className="mt-6 flex items-center gap-2 border-t border-line pt-4">
            {step > 0 && (
              <Button onClick={back}>
                <ArrowLeft /> Back
              </Button>
            )}
            <div className="ml-auto" />
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={next}>
                {step === 0 ? 'Get Started' : 'Continue'} <ArrowRight />
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()}>
                Open Yaho <ArrowRight />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <p>Yaho runs long-lived AI agents on a schedule. Each agent has a briefing, a workspace that it keeps between runs, and a budget.</p>
      <p>Agents work on their own and come to you only when they need you: a question, an instruction or a result, in your inbox.</p>
      <p className="text-muted">This setup takes a few minutes: which models to use, Claude Code, and your budget.</p>
    </div>
  );
}

/** A line with a tick, a cross or a spinner. */
function Status({ state, children }: { state: 'ok' | 'fail' | 'busy' | 'idle'; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 shrink-0">
        {state === 'ok' ? (
          <Check className="size-4 text-ok" />
        ) : state === 'fail' ? (
          <X className="size-4 text-danger" />
        ) : state === 'busy' ? (
          <Loader2 className="size-4 animate-spin text-muted" />
        ) : (
          <span className="block size-4 rounded-full border border-line" />
        )}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ModelsStep({ settings }: { settings: SetupSettings }) {
  const providers = useApi<ProviderInfo[]>('/api/providers');
  const current = settings.providers.find((p) => p.id === (settings.default_provider ?? settings.providers[0]?.id));
  const [kind, setKind] = useState(current?.kind ?? 'litellm');
  const existing = settings.providers.find((p) => p.kind === kind);
  const id = existing?.id ?? kind;
  const [url, setUrl] = useState(existing?.url ?? 'http://localhost:4000');
  const [key, setKey] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [model, setModel] = useState(settings.defaults.models[0] ?? '');
  const [chatModel, setChatModel] = useState(settings.assistant?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (k: string) => {
    setKind(k);
    setModels(null);
    setKey('');
    setError(null);
    const p = settings.providers.find((x) => x.kind === k);
    setUrl(p?.url ?? 'http://localhost:4000');
  };
  const keyStored = !!settings.secrets_set?.[`providers.${id}.api_key`];
  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      // The chosen provider, added if new, becomes the default; its models are then plain names.
      await save((s) => {
        let p = s.providers.find((x) => x.kind === kind);
        if (!p) s.providers.push((p = { id: kind, kind }));
        if (kind === 'litellm') p.url = url.trim();
        if (key) p.api_key = key;
        s.default_provider = p.id;
      });
      const r = await api<{ models: string[] }>(`/api/providers/${id}/models`);
      // OpenRouter serves Claude Code Anthropic's models only.
      const usable = kind === 'openrouter' ? r.models.filter((m) => m.startsWith('anthropic/')) : r.models;
      setModels(usable);
      if (!usable.includes(model)) setModel(usable.find((m) => /sonnet/.test(m)) ?? usable[0] ?? '');
      if (chatModel && !usable.includes(chatModel)) setChatModel('');
    } catch (e) {
      setModels(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (models && model)
      void save((s) => {
        s.defaults.models = [model, ...s.defaults.models.filter((m) => m !== model && models.includes(m))];
        s.assistant = { ...s.assistant, model: chatModel || undefined };
      });
  }, [models, model, chatModel]);
  const info = providers.data?.find((p) => p.kind === kind);
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Model provider">
        {(providers.data ?? []).map((p) => (
          <button
            key={p.kind}
            type="button"
            role="radio"
            aria-checked={p.kind === kind}
            disabled={!p.available}
            onClick={() => pick(p.kind)}
            className={cn(
              'flex gap-3 rounded-xl border p-3 text-left text-sm',
              !p.available ? 'border-line opacity-60' : p.kind === kind ? 'border-accent bg-accent/5 ring-1 ring-accent/40' : 'cursor-pointer border-line hover:border-accent/50',
            )}
          >
            {p.kind in BRAND_LOGOS ? (
              <BrandLogo brand={p.kind} />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white">
                <Cpu className="size-4 text-muted" />
              </span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 font-medium">
                {p.label}
                {!p.available && <span className="rounded-full bg-hover px-1.5 text-[10.5px] font-normal text-muted">Coming Soon</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted">{p.description}</div>
            </div>
          </button>
        ))}
      </div>
      {kind === 'litellm' && (
        <Field label="LiteLLM URL" hint="The address of your LiteLLM proxy.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:4000" />
        </Field>
      )}
      <Field label={`${info?.label ?? 'API'} Key`} hint={keyStored ? 'A key is stored. Type a new one to replace it.' : 'Kept in the secrets store; agents never see it.'}>
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyStored ? 'Value set' : ''} />
      </Field>
      <div className="flex items-center gap-3">
        <Button onClick={() => void test()} disabled={busy || (kind === 'litellm' && !url.trim()) || (!key && !keyStored)}>
          {busy && <Loader2 className="animate-spin" />} Test Connection
        </Button>
        {models && <Status state="ok">{models.length} models available</Status>}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {models && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default Model" hint="What agents use unless they say otherwise.">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Chat Model" hint="For the Yaho chat. Empty means the default model.">
            <Select value={chatModel} onChange={(e) => setChatModel(e.target.value)}>
              <option value="">Same as Default</option>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  );
}

/** Installed, recent enough, and able to answer through the provider: with Check Again. Also used in Settings. */
export function ClaudeCheckPanel({ auto = true }: { auto?: boolean }) {
  const last = useApi<ClaudeCheck | null>('/api/checks/claude', (e) => e.type === 'changed' && e.entity === 'checks');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/checks/claude', { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      last.reload();
    }
  };
  useEffect(() => {
    if (auto) void run();
  }, []);
  // Before the first check the API has no result (it answers {ok: true}); only a real check has a time.
  const c = busy || !last.data?.checked_at ? null : last.data;
  const state = (ok: boolean | undefined, reached: boolean): 'ok' | 'fail' | 'busy' | 'idle' =>
    busy ? 'busy' : !c ? 'idle' : ok ? 'ok' : reached ? 'fail' : 'idle';
  return (
    <div className="space-y-3">
      <Status state={state(c?.installed, true)}>{c?.installed ? 'Claude Code is installed' : 'Claude Code is installed'}</Status>
      <Status state={state(c?.recent, !!c?.installed)}>{c?.version ? `Version ${c.version}` : 'A recent version'}</Status>
      <Status state={state(c?.works, !!c?.recent)}>
        {c?.works ? `It answers through your provider (${c.model})` : 'It answers through your model provider'}
      </Status>
      {c?.error && (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs">
          <div className="mb-1 font-medium text-danger">
            {c.failed === 'provider' ? 'The model provider did not answer' : c.failed === 'install' ? 'Not installed' : c.failed === 'version' ? 'Too old' : 'Claude Code failed'}
          </div>
          <pre className="font-mono break-words whitespace-pre-wrap text-ink/80">{c.error}</pre>
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => void run()} disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} {busy ? 'Checking…' : 'Check Again'}
        </Button>
        {c && !busy && <span className="text-xs text-muted">Checked {new Date(c.checked_at).toLocaleTimeString()}</span>}
      </div>
    </div>
  );
}

function ClaudeStep() {
  return (
    <div className="space-y-4 text-sm">
      <p>Agents run in Claude Code. Yaho checks that it is installed and that it can reach your models with a short test run.</p>
      <ClaudeCheckPanel />
    </div>
  );
}

function BudgetStep({ settings }: { settings: SetupSettings }) {
  const [cap, setCap] = useState(String(settings.global_spend_cap_usd));
  const [perJob, setPerJob] = useState(String(settings.defaults.budget_usd));
  useEffect(() => {
    const t = setTimeout(() => {
      const c = Number(cap);
      const j = Number(perJob);
      if (c > 0 && j > 0)
        void save((s) => {
          s.global_spend_cap_usd = c;
          s.defaults.budget_usd = j;
        });
    }, 400);
    return () => clearTimeout(t);
  }, [cap, perJob]);
  return (
    <div className="space-y-4 text-sm">
      <p>Yaho stops agents before they spend more than you allow. You can change these at any time, and per agent.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Monthly Spend Cap (USD)" hint="All agents together.">
          <Input type="number" min={1} value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <Field label="Default Budget per Agent (USD)" hint="New agents start with this.">
          <Input type="number" min={1} value={perJob} onChange={(e) => setPerJob(e.target.value)} />
        </Field>
      </div>
    </div>
  );
}

function ConnectionsStep({ settings }: { settings: SetupSettings }) {
  const [composio, setComposio] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-4 text-sm">
      <p>Optional. You can connect these later in Settings.</p>
      <div className="rounded-xl border border-line p-4">
        <div className="flex items-center gap-2 font-medium">
          <BrandLogo brand="slack" size="sm" />
          Slack
        </div>
        <p className="mt-1 text-xs text-muted">Get your inbox as Slack messages and answer from there. Set it up in Settings → Integrations; it takes about five minutes.</p>
      </div>
      <div className="space-y-3 rounded-xl border border-line p-4">
        <div className="flex items-center gap-2 font-medium">
          <BrandLogo brand="composio" size="sm" />
          Composio
        </div>
        <p className="text-xs text-muted">Gives agents access to Gmail, Google Calendar, GitHub and hundreds of other apps.</p>
        <Field label="Composio API Key" hint={settings.secrets_set?.['composio.api_key'] ? 'A key is stored. Type a new one to replace it.' : 'From composio.dev → Settings → API Keys.'}>
          <div className="flex gap-2">
            <div className="flex-1">
              <Input type="password" value={composio} onChange={(e) => setComposio(e.target.value)} placeholder={settings.secrets_set?.['composio.api_key'] ? 'Value set' : ''} />
            </div>
            <Button
              disabled={!composio}
              onClick={async () => {
                await save((s) => void (s.composio = { ...s.composio, api_key: composio }));
                setComposio('');
                setSaved(true);
              }}
            >
              Save
            </Button>
          </div>
        </Field>
        {saved && <Status state="ok">Saved</Status>}
      </div>
    </div>
  );
}

function FinishStep() {
  const [shortcut, setShortcut] = useState(true);
  const [result, setResult] = useState<{ files: string[]; error?: string } | null>(null);
  const canShortcut = !!platform.createShortcut && platform.os !== 'darwin';
  return (
    <div className="space-y-4 text-sm">
      <p>Yaho is ready. Create your first agent from the Library, or ask the chat (the sparkles icon) to make one for you.</p>
      {canShortcut && (
        <div className="space-y-2">
          <Switch checked={shortcut} onChange={setShortcut} label="Put Yaho on the Desktop and in the Start Menu" />
          {shortcut && !result && (
            <Button size="sm" onClick={() => void platform.createShortcut!().then(setResult)}>
              Create Shortcuts
            </Button>
          )}
          {result && (
            <Status state={result.error ? 'fail' : 'ok'}>{result.error ?? `Made ${result.files.length} shortcut${result.files.length === 1 ? '' : 's'}`}</Status>
          )}
        </div>
      )}
      {platform.os === 'darwin' && <p className="text-xs text-muted">Yaho is in your Applications folder, so Launchpad and Spotlight find it.</p>}
      <p className="text-xs text-muted">
        From a terminal, <code>yaho</code> opens this window and <code>yaho doctor</code> checks the install.
      </p>
    </div>
  );
}
