import { Card } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { api, useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import { href } from '../../lib/router.ts';
import { Check } from '../settings/Check.tsx';
import type { Settings } from '../settings/types.ts';
import { StatusLine, type Summary } from './shared.tsx';

export interface ComposioHealth {
  configured: boolean;
  error?: string;
  connections?: Array<{ status: string; toolkit: string; resources: string[] }>;
}

/** Composio is fine while its key works and every connection a resource uses is active (an expired sign-in needs attention). */
export function composioSummary(h?: ComposioHealth): Summary {
  if (!h) return { state: 'off', line: '' };
  if (!h.configured) return { state: 'off', line: 'Not set up.' };
  if (h.error) return { state: 'error', line: `Not connected: ${h.error}` };
  const conns = h.connections ?? [];
  const broken = conns.filter((c) => !['ACTIVE', 'INITIATED', 'INITIALIZING'].includes(c.status));
  if (broken.length)
    return {
      state: 'warn',
      line: `${broken.length} connection${broken.length === 1 ? ' needs' : 's need'} attention: ${broken.map((c) => `${c.toolkit} (${c.status.toLowerCase()})`).join(', ')}.`,
    };
  return { state: 'ok', line: `Connected · ${conns.length} connection${conns.length === 1 ? '' : 's'}.` };
}

export function useComposioHealth(enabled: boolean): ComposioHealth | undefined {
  const status = useApi<{ configured: boolean }>(
    enabled ? '/api/composio/status' : null,
    (e) => e.type === 'changed' && e.entity === 'settings',
  );
  const conns = useApi<ComposioHealth['connections']>(
    enabled && status.data?.configured ? '/api/composio/connections' : null,
    (e) => e.type === 'changed' && (e.entity === 'settings' || e.entity === 'resources'),
  );
  if (!status.data) return undefined;
  if (!status.data.configured) return { configured: false };
  if (conns.error) return { configured: true, error: conns.error };
  if (!conns.data) return undefined;
  return { configured: true, connections: conns.data };
}

export function ComposioSettings({
  settings: s,
  upd,
  save,
}: {
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  save: () => Promise<boolean>;
}) {
  const health = useComposioHealth(true);
  const summary = composioSummary(health);
  return (
    <Card className="grid gap-4 p-4 md:grid-cols-2">
      {health && (
        <div className="md:col-span-2">
          <StatusLine {...summary} />
        </div>
      )}
      <ComposioKeyHelp />
      <Field label="Composio API Key" hint="Agents never see it: Yaho makes their calls.">
        <Input
          type="password"
          value={s.composio?.api_key ?? ''}
          placeholder={s.secrets_set?.['composio.api_key'] ? 'Value set · type to replace' : undefined}
          onChange={(e) => upd((d) => void (d.composio = { ...d.composio, api_key: e.target.value || undefined }))}
        />
      </Field>
      <Field label="User ID" hint="Whose connections Yaho uses in your Composio project.">
        <Input
          value={s.composio?.user_id ?? 'yaho'}
          onChange={(e) => upd((d) => void (d.composio = { ...d.composio, user_id: e.target.value || undefined }))}
        />
      </Field>
      <div className="md:col-span-2">
        <Check
          label="Test Composio"
          run={async () => {
            if (!(await save())) throw new Error('could not save the settings');
            const r = await api<Array<{ toolkit: string }>>('/api/composio/connections');
            return `connected · ${r.length} connection${r.length === 1 ? '' : 's'}`;
          }}
        />
      </div>
    </Card>
  );
}

/** How to create a Composio API key, and which permissions Yaho needs. */
export function ComposioKeyHelp() {
  const rows: Array<[string, string, string]> = [
    ['Toolkits', 'Read', 'the All Apps list'],
    ['Tools', 'Read', 'tool lists and their inputs'],
    ['Connected accounts', 'Read + Write', 'your connections; Write lets the Connect button add new ones'],
    ['Auth configs', 'Read + Write', 'Write sets up sign-in the first time you connect an app'],
    ['Tool execution', 'Write', 'agents running tools with yaho tool'],
  ];
  return (
    <details className="group rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm md:col-span-2">
      <summary className="cursor-pointer font-medium text-ink/90 select-none">How to Get a Composio API Key</summary>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-ink/85">
        <li>
          Sign in at{' '}
          <button
            type="button"
            className="cursor-pointer text-accent underline"
            onClick={() => platform.openExternal('https://platform.composio.dev')}
          >
            platform.composio.dev
          </button>{' '}
          (a free account is enough) and open your project.
        </li>
        <li>Go to the project's Settings → API Keys and choose Create API key. Name it, for example, "Yaho".</li>
        <li>Tick these permissions. They can't be changed later, so check them before you create the key:</li>
      </ol>
      <table className="mt-2 ml-5 text-xs">
        <tbody>
          {rows.map(([perm, level, why]) => (
            <tr key={perm}>
              <td className="py-0.5 pr-4 font-medium">{perm}</td>
              <td className="py-0.5 pr-4 whitespace-nowrap text-accent">{level}</td>
              <td className="py-0.5 text-muted">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 ml-5 text-xs text-muted">
        Sessions, session tool execution and triggers are not used. Tool execution sits further down Composio's list than the others.
      </p>
      <ol start={4} className="mt-2 list-decimal space-y-1.5 pl-5 text-ink/85">
        <li>Copy the key, paste it below and press Test Composio. Composio shows the key only once.</li>
        <li>
          Then open{' '}
          <a className="text-accent underline" href={href('resources', 'composio')}>
            Resources → From Composio
          </a>{' '}
          to connect apps and add them as resources.
        </li>
      </ol>
    </details>
  );
}
