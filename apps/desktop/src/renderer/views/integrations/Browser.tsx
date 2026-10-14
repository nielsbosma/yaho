import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input, Select, Switch } from '../../components/ui/form.tsx';
import { api, useApi } from '../../lib/api.ts';
import type { Settings } from '../settings/types.ts';
import { StatusLine, SUMMARY, type BrowserStatus } from './shared.tsx';

export const BROWSER_PROVIDERS = {
  local: 'This computer',
  browserbase: 'Browserbase',
  steel: 'Steel',
  cdp: 'Other (CDP URL)',
} as const;

export function BrowserSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['browser']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['browser']>) => void;
}) {
  const status = useApi<BrowserStatus>('/api/browser', (e) => e.type === 'changed' && e.entity === 'settings');
  const [test, setTest] = useState<{ ok: boolean; error?: string; version?: string } | 'running' | null>(null);
  const set = (patch: Partial<NonNullable<Settings['browser']>>) => onChange({ ...value, ...patch });
  const provider = value.provider ?? 'local';
  const { line, state } = SUMMARY.browser(status.data ?? undefined);
  const secret = (path: string, label: string) => (stored[path] ? 'Value set · type to replace' : label);
  return (
    <Card className="space-y-4 p-4">
      <StatusLine
        state={state}
        line={line}
        action={
          <Button
            size="sm"
            disabled={test === 'running'}
            onClick={async () => {
              setTest('running');
              setTest(
                await api<{ ok: boolean; error?: string; version?: string }>('/api/browser/test', { method: 'POST' }).catch((e: Error) => ({
                  ok: false,
                  error: e.message,
                })),
              );
            }}
          >
            {test === 'running' ? 'Testing…' : 'Test'}
          </Button>
        }
      />
      {test && test !== 'running' && (
        <p className={cn('text-xs', test.ok ? 'text-ok' : 'text-danger')}>
          {test.ok ? `Started ${test.version ?? 'the browser'} and closed it again.` : test.error}
        </p>
      )}
      <p className="text-sm text-muted">
        Agents with <b className="text-ink">Browser</b> on (in the agent's settings under Access) get a browser of their own in each job,
        closed when the job ends, and drive it with <code>yaho browser</code>. Sign-ins stay between jobs. Save Settings before testing a
        change.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Where It Runs">
          <Select
            value={provider}
            onChange={(e) => set({ provider: e.target.value === 'local' ? undefined : (e.target.value as typeof provider) })}
          >
            {Object.entries(BROWSER_PROVIDERS).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {provider === 'local' && (
          <>
            <Field label="Browser Path" hint="Empty: the installed Chrome, Edge or Chromium.">
              <Input
                value={value.executable ?? ''}
                placeholder={status.data?.provider === 'local' && status.data.ready ? status.data.detail : ''}
                onChange={(e) => set({ executable: e.target.value.trim() || undefined })}
              />
            </Field>
            {!server && (
              <label className="flex items-start gap-3 text-sm md:col-span-2">
                <Switch
                  checked={value.headless === false}
                  label="Show the Window"
                  onChange={(v) => set({ headless: v ? false : undefined })}
                />
                <span>
                  Show the Window
                  <span className="block text-xs text-muted">
                    Watch agents browse, and step in to sign in or solve a captcha. Off: the browser runs hidden.
                  </span>
                </span>
              </label>
            )}
          </>
        )}
        {(provider === 'browserbase' || provider === 'steel') && (
          <Field label="API Key" hint="Agents never see it.">
            <Input
              type="password"
              value={value.api_key ?? ''}
              placeholder={secret('browser.api_key', 'API Key')}
              onChange={(e) => set({ api_key: e.target.value.trim() || undefined })}
            />
          </Field>
        )}
        {provider === 'browserbase' && (
          <Field label="Project ID">
            <Input value={value.project_id ?? ''} onChange={(e) => set({ project_id: e.target.value.trim() || undefined })} />
          </Field>
        )}
        {provider === 'cdp' && (
          <Field label="CDP URL" hint="A ws:// or wss:// endpoint (or http:// to look it up), e.g. Browserless or Browser Use.">
            <Input
              type="password"
              value={value.cdp_url ?? ''}
              placeholder={secret('browser.cdp_url', 'wss://…')}
              onChange={(e) => set({ cdp_url: e.target.value.trim() || undefined })}
            />
          </Field>
        )}
      </div>
      {provider !== 'local' && (
        <p className="text-xs text-muted">
          Each job gets its own session at {BROWSER_PROVIDERS[provider]}, released when the job ends; its live view is linked in the job.
          Cookies are saved between jobs.
        </p>
      )}
      <p className="text-xs text-muted">Which sites the browser may open is set in Guard Rails.</p>
    </Card>
  );
}
