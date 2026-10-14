import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button.tsx';
import { ago } from './ui/display.tsx';
import { Field, Input, Select, Switch, Textarea } from './ui/form.tsx';
import { api, useApi, type Webhook, type WebhookTrigger, type WebhookVerify } from '../lib/api.ts';

export const VERIFY_LABEL: Record<WebhookVerify, string> = {
  none: 'URL only',
  github: 'GitHub',
  stripe: 'Stripe',
  svix: 'Svix / Standard Webhooks',
  yaho: 'Yaho signature',
};

const VERIFY_HELP: Record<WebhookVerify, string> = {
  none: 'Anyone with the URL can start a job, so keep it private.',
  github: "In the repository's Settings → Webhooks: paste the URL as Payload URL, pick application/json, and copy the secret in.",
  stripe: "Add an endpoint with this URL in Stripe's Webhooks, then paste its signing secret (whsec_…) here.",
  svix: "Paste the sender's signing secret (whsec_…) here, or give it this one.",
  yaho: 'Send the header X-Yaho-Signature: t=<unix time>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>.',
};

export const webhookUrl = (path: string, server: boolean) => (server ? `${location.origin}${path}` : `https://<your tunnel>${path}`);

/** The agent's webhook triggers: each a URL that starts a job, with an optional signature check. */
export function WebhookTriggers({
  agent,
  value,
  onChange,
  server,
}: {
  agent: string | null;
  value: WebhookTrigger[];
  onChange: (v: WebhookTrigger[]) => void;
  server: boolean;
}) {
  const saved = useApi<Webhook[]>(
    agent ? `/api/webhooks?agent=${encodeURIComponent(agent)}` : null,
    (e) => e.type === 'changed' && (e.entity === 'webhooks' || e.entity === 'agents'),
  );
  const put = (i: number, next: Partial<WebhookTrigger>) => onChange(value.map((w, j) => (j === i ? { ...w, ...next } : w)));
  const add = () => {
    let n = value.length + 1;
    while (value.some((w) => w.webhook === `hook-${n}`)) n++;
    onChange([...value, { webhook: `hook-${n}` }]);
  };
  return (
    <div className="space-y-3">
      {!server && (
        <p className="text-sm text-muted">
          Senders on the internet reach Yaho only in the server version. On the desktop, a webhook needs a tunnel to this computer.
        </p>
      )}
      {value.map((w, i) => (
        <WebhookRow
          key={i}
          value={w}
          saved={saved.data?.find((s) => s.name === w.webhook)}
          server={server}
          onChange={(next) => put(i, next)}
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
          reload={saved.reload}
        />
      ))}
      <Button size="sm" onClick={add}>
        <Plus /> Add Webhook
      </Button>
    </div>
  );
}

function WebhookRow({
  value: w,
  saved,
  server,
  onChange,
  onRemove,
  reload,
}: {
  value: WebhookTrigger;
  saved?: Webhook;
  server: boolean;
  onChange: (v: Partial<WebhookTrigger>) => void;
  onRemove: () => void;
  reload: () => void;
}) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const verify = w.verify ?? 'none';
  const call = (path: string, init: { method: string; body?: unknown }) =>
    api(path, init)
      .then(() => {
        setError(null);
        setPasted('');
        reload();
      })
      .catch((e: Error) => setError(e.message));
  const unsaved = saved && (saved.verify !== verify ? 'Save to switch the signature check.' : null);
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_7rem_auto_auto]">
        <Field label="Name">
          <Input value={w.webhook} onChange={(e) => onChange({ webhook: e.target.value })} placeholder="github-issues" />
        </Field>
        <Field label="Signature Check">
          <Select
            value={verify}
            onChange={(e) => onChange({ verify: e.target.value === 'none' ? undefined : (e.target.value as WebhookVerify) })}
          >
            {Object.entries(VERIFY_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Per Hour">
          <Input
            type="number"
            min="1"
            value={w.limit ?? 60}
            onChange={(e) =>
              onChange({ limit: e.target.value === '' || Number(e.target.value) === 60 ? undefined : Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Paused">
          <div className="flex h-9 items-center">
            <Switch checked={!!w.paused} onChange={(v) => onChange({ paused: v || undefined })} label="Paused" />
          </div>
        </Field>
        <Button variant="ghost" size="icon" onClick={onRemove} title="Remove webhook" aria-label="Remove webhook">
          <Trash2 />
        </Button>
      </div>
      <Field
        label="Instructions"
        hint="Added to the prompt of every job this webhook starts. The payload itself is in the agent's workspace."
      >
        <Textarea
          className="min-h-16"
          value={w.instructions ?? ''}
          onChange={(e) => onChange({ instructions: e.target.value || undefined })}
          placeholder="Triage the new GitHub issue: label it and tell me if it is urgent."
        />
      </Field>
      {!saved ? (
        <p className="text-xs text-muted">The URL appears when you save.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-hover px-2 py-1 text-xs">{webhookUrl(saved.path, server)}</code>
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhookUrl(saved.path, server))}>
              Copy URL
            </Button>
            <Button
              size="sm"
              onClick={() => void call(`/api/webhooks/${saved.id}/rotate`, { method: 'POST' })}
              title="The old URL stops working"
            >
              New URL
            </Button>
          </div>
          {verify !== 'none' && !unsaved && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(saved.secret)}>
                Copy Secret
              </Button>
              <Button size="sm" onClick={() => void call(`/api/webhooks/${saved.id}/secret`, { method: 'PUT', body: {} })}>
                New Secret
              </Button>
              <Input
                className="h-7 min-w-0 flex-1 text-xs"
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Or paste the sender's secret"
              />
              <Button
                size="sm"
                disabled={!pasted.trim()}
                onClick={() => void call(`/api/webhooks/${saved.id}/secret`, { method: 'PUT', body: { secret: pasted.trim() } })}
              >
                Use Secret
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">{unsaved ?? VERIFY_HELP[verify]}</p>
          {error && <p className="text-xs text-danger">{error}</p>}
          <p className="text-xs text-muted">
            {saved.last_delivery
              ? `Last delivery ${ago(saved.last_delivery)}, ${saved.deliveries_24h} in the last day.`
              : 'No deliveries yet.'}
            {saved.last_rejected &&
              ` Last refused ${ago(saved.last_rejected.split(' ')[0])}: ${saved.last_rejected.split(' ').slice(1).join(' ')}.`}
          </p>
        </div>
      )}
    </div>
  );
}
