import { Check as CheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { PageHeader } from '../components/ui/display.tsx';
import type { AppState } from '../App.tsx';
import { api, useApi } from '../lib/api.ts';
import { Integrations } from './integrations.tsx';
import { Advanced } from './settings/Advanced.tsx';
import { Appearance } from './settings/Appearance.tsx';
import { Debug } from './settings/Debug.tsx';
import { Defaults } from './settings/Defaults.tsx';
import { GuardRails } from './settings/GuardRails.tsx';
import { Harnesses } from './settings/Harnesses.tsx';
import { ModelProviders } from './settings/ModelProviders.tsx';
import { Pane, SettingsPanes } from './settings/Panes.tsx';
import { ServerAccess } from './settings/ServerAccess.tsx';
import { Updates } from './settings/Updates.tsx';
import type { Settings } from './settings/types.ts';

export { Check } from './settings/Check.tsx';
export type { Settings } from './settings/types.ts';

/** Equal settings, whatever order their keys were set in; an empty value counts as absent. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined && x !== '')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export function SettingsView({ route }: { route: string[] }) {
  const state = useApi<AppState>('/api/state');
  const saved = useApi<Settings>('/api/settings', (e) => e.type === 'changed' && e.entity === 'settings');
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  /** What the page last loaded: a change elsewhere (the chat, another window) replaces the page only when it has no edits. */
  const [base, setBase] = useState<Settings | null>(null);
  useEffect(() => {
    if (!saved.data) return;
    setS((prev) => (prev && base && !same(prev, base) ? prev : structuredClone(saved.data!)));
    setBase(saved.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);
  if (!s) return null;
  /** Something differs from what was last loaded or saved. */
  const dirty = !!base && same(s, base) === false;

  const upd = (fn: (d: Settings) => void) =>
    setS((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });

  /** Save; false when it failed (the error shows at the top), so a Test after it stops. */
  const save = async (): Promise<boolean> => {
    setError(null);
    setOk(false);
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      setBase(s);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        actions={
          <div className="relative flex items-center gap-2">
            {/* Fades in after a save and away again by itself. Positioned outside the flow, so the buttons stay on the right edge. */}
            <span
              role="status"
              aria-live="polite"
              className={cn(
                'pointer-events-none absolute top-1/2 right-full mr-3 flex -translate-y-1/2 items-center gap-1 text-sm whitespace-nowrap text-ok transition-all duration-300',
                ok ? 'translate-x-0 opacity-100' : 'translate-x-1 opacity-0',
              )}
            >
              <CheckIcon className="size-4" /> Saved
            </span>
            <Button onClick={() => void api('/api/onboarding/reset', { method: 'POST' }).then(() => location.reload())}>
              Run Setup Again
            </Button>
            <Button variant="primary" disabled={!dirty} title={dirty ? undefined : 'Nothing to save'} onClick={() => void save()}>
              Save Settings
            </Button>
          </div>
        }
      />
      <SettingsPanes active={route[1]} error={error}>
        <Pane id="appearance" label="Appearance">
          <Appearance />
        </Pane>
        <Pane id="models" label="Model Providers">
          <ModelProviders settings={s} upd={upd} save={save} />
        </Pane>
        <Pane id="integrations" label="Integrations">
          <Integrations route={route.slice(2)} settings={s} upd={upd} save={save} server={!!state.data?.server} />
        </Pane>
        <Pane id="guardrails" label="Guard Rails">
          <GuardRails settings={s} upd={upd} />
        </Pane>
        <Pane id="defaults" label="Defaults">
          <Defaults settings={s} upd={upd} />
        </Pane>
        {state.data?.server && (
          <Pane id="server" label="Server Access">
            <ServerAccess />
          </Pane>
        )}
        <Pane id="updates" label="Updates">
          <Updates settings={s} upd={upd} />
        </Pane>
        <Pane id="harnesses" label="Harnesses">
          <Harnesses settings={s} upd={upd} desktop={!state.data?.server} />
        </Pane>
        <Pane id="advanced" label="Advanced">
          <Advanced settings={s} upd={upd} save={save} />
        </Pane>
        {state.data?.debug && (
          <Pane id="debug" label="Debug">
            <Debug settings={s} upd={upd} />
          </Pane>
        )}
      </SettingsPanes>
    </div>
  );
}
