import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input, Switch } from '../../components/ui/form.tsx';
import { useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import type { Settings } from '../settings/types.ts';
import { DOT, listText, SUMMARY, useAction, type EmailStatus } from './shared.tsx';

/**
 * Email for agents through Resend: agents with Email on get <name>@<domain>, and replies come back through Resend's
 * inbound webhook, so Yaho must be reachable over HTTPS like for WhatsApp.
 */
export function EmailSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['resend']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['resend']>) => void;
}) {
  const status = useApi<EmailStatus>('/api/resend', (e) => e.type === 'changed' && (e.entity === 'resend' || e.entity === 'settings'));
  const st = status.data;
  const [actionError, post] = useAction();
  const set = (patch: Partial<NonNullable<Settings['resend']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.email(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Add your domain to Resend',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://resend.com/domains')}>
            Open Resend Domains
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Add a domain (a subdomain such as <code>agents.example.com</code> keeps it apart from your own mail), add the DNS records Resend
          shows, and turn on <b className="text-ink">Receiving</b> for it, which adds an MX record. Every address on it then reaches Yaho.
        </p>
      </>,
    ],
    [
      'Make an API key',
      <p className="mt-0.5 text-muted">
        In <b className="text-ink">API Keys</b> create a key with <b className="text-ink">Full access</b> (Yaho reads received emails, which
        a sending-only key cannot) and paste it below.
      </p>,
    ],
    [
      'Point the webhook at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          In <b className="text-ink">Webhooks</b> add an endpoint with this URL and the <b className="text-ink">email.received</b> event,
          then paste its <b className="text-ink">Signing Secret</b> below.
        </p>
        <div className="mt-1.5">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Webhook URL
          </Button>
        </div>
        {st?.last_webhook && (
          <p className="mt-1 text-xs text-muted">Last heard from Resend {new Date(st.last_webhook).toLocaleString()}.</p>
        )}
        {st?.last_ignored && <p className="mt-1 text-xs text-muted">Last email not delivered: {st.last_ignored}</p>}
      </>,
    ],
    [
      'Turn on Email for an agent',
      <p className="mt-0.5 text-muted">
        In the agent's settings under <b className="text-ink">Access</b>. With its Inbox Trigger on, a reply starts a job right away.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => post('/api/resend/reconnect', status.reload)}>
            Reconnect
          </Button>
        )}
      </div>
      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      <ol className="space-y-3 text-sm">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="font-medium">{title}</div>
              {body}
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Domain" hint="Verified in Resend, with receiving on.">
          <Input
            value={value.domain ?? ''}
            placeholder="agents.example.com"
            onChange={(e) => set({ domain: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="API Key" hint="Full access.">
          <Input
            type="password"
            value={value.api_key ?? ''}
            placeholder={stored['resend.api_key'] ? 'Value set · type to replace' : 're_…'}
            onChange={(e) => set({ api_key: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Webhook Signing Secret" hint="Checks that webhook calls come from Resend.">
          <Input
            type="password"
            value={value.webhook_secret ?? ''}
            placeholder={stored['resend.webhook_secret'] ? 'Value set · type to replace' : 'whsec_…'}
            onChange={(e) => set({ webhook_secret: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field
          label="Accept New Emails"
          hint="Off: agents only get replies to emails they sent. On: anyone who writes to an agent's address reaches it."
        >
          <div className="flex h-9 items-center">
            <Switch checked={!!value.accept_new} onChange={(v) => set({ accept_new: v || undefined })} label="Accept New Emails" />
          </div>
        </Field>
        <Field label="Allowed Senders" hint="Addresses or domains that may write to agents, comma-separated. Empty: anyone.">
          <Input
            value={listText(value.allow)}
            placeholder="anna@example.com, partner.io"
            onChange={(e) => set({ allow: e.target.value || undefined })}
          />
        </Field>
        <Field label="Only Thread Participants" hint="On: a reply to a thread must come from an address already in it.">
          <div className="flex h-9 items-center">
            <Switch
              checked={!!value.participants_only}
              onChange={(v) => set({ participants_only: v || undefined })}
              label="Only Thread Participants"
            />
          </div>
        </Field>
      </div>
    </Card>
  );
}
