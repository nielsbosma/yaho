import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input, Select } from '../../components/ui/form.tsx';
import { useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import type { Settings } from '../settings/types.ts';
import { DOT, listText, SUMMARY, useAction, type SmsStatus } from './shared.tsx';

/**
 * SMS for agents through Twilio: agents with SMS on share one number, and texts to it come back through Twilio's
 * webhook to the agent that last texted that phone, so Yaho must be reachable over HTTPS like for Email.
 */
export function SmsSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['twilio']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['twilio']>) => void;
}) {
  const status = useApi<SmsStatus>('/api/twilio', (e) => e.type === 'changed' && (e.entity === 'twilio' || e.entity === 'settings'));
  const agents = useApi<Array<{ name: string; sms?: boolean }>>('/api/agents');
  const st = status.data;
  const [actionError, post] = useAction();
  const set = (patch: Partial<NonNullable<Settings['twilio']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.sms(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Get a Twilio number',
      <>
        <div className="mt-1.5">
          <Button
            size="sm"
            variant="primary"
            onClick={() => platform.openExternal('https://console.twilio.com/us1/develop/phone-numbers/manage/incoming')}
          >
            Open Twilio Numbers
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Buy a number that can send and receive <b className="text-ink">SMS</b> in the country of the people your agents will text (some
          countries need a registration first), and type it below in international form.
        </p>
      </>,
    ],
    [
      'Copy the account keys',
      <p className="mt-0.5 text-muted">
        The <b className="text-ink">Account SID</b> and <b className="text-ink">Auth Token</b> on the Twilio Console's home page; paste them
        below. The token also checks that webhook calls come from Twilio.
      </p>,
    ],
    [
      'Point the number at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          On the number's page under <b className="text-ink">Messaging Configuration</b>, set <b className="text-ink">A message comes in</b>{' '}
          to Webhook, this URL, HTTP POST, and save.
        </p>
        <div className="mt-1.5">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Webhook URL
          </Button>
        </div>
        {st?.last_webhook && (
          <p className="mt-1 text-xs text-muted">Last heard from Twilio {new Date(st.last_webhook).toLocaleString()}.</p>
        )}
        {st?.last_ignored && <p className="mt-1 text-xs text-muted">Last text not delivered: {st.last_ignored}</p>}
      </>,
    ],
    [
      'Turn on SMS for an agent',
      <p className="mt-0.5 text-muted">
        In the agent's settings under <b className="text-ink">Access</b>. A reply goes to the agent that texted that phone last, and with
        its Inbox Trigger on it starts a job right away.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => post('/api/twilio/reconnect', status.reload)}>
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
        <Field label="Phone Number" hint="The Twilio number, in international form.">
          <Input
            value={value.number ?? ''}
            placeholder="+46701234567"
            onChange={(e) => set({ number: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Account SID">
          <Input
            value={value.account_sid ?? ''}
            placeholder="AC…"
            onChange={(e) => set({ account_sid: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Auth Token">
          <Input
            type="password"
            value={value.auth_token ?? ''}
            placeholder={stored['twilio.auth_token'] ? 'Value set · type to replace' : 'Auth Token'}
            onChange={(e) => set({ auth_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="New Texts Go To" hint="Texts from phones no agent has texted. Nobody: they are dropped.">
          <Select value={value.new_agent ?? ''} onChange={(e) => set({ new_agent: e.target.value || undefined })}>
            <option value="">Nobody</option>
            {(agents.data ?? [])
              .filter((a) => a.sms || a.name === value.new_agent)
              .map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Allowed Numbers" hint="Phones that may text agents, comma-separated. Empty: any phone.">
          <Input
            value={listText(value.allow)}
            placeholder="+46701234567, +46709876543"
            onChange={(e) => set({ allow: e.target.value || undefined })}
          />
        </Field>
        <Field label="Public URL" hint="Where Twilio reaches Yaho, checked against its signatures. Empty: the request's own host.">
          <Input
            value={value.public_url ?? ''}
            placeholder="https://yaho.example.com"
            onChange={(e) => set({ public_url: e.target.value.trim() || undefined })}
          />
        </Field>
      </div>
    </Card>
  );
}
