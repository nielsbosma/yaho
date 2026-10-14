import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import type { Settings } from '../settings/types.ts';
import { DOT, PostChoice, SUMMARY, useAction, type WhatsAppStatus } from './shared.tsx';

/**
 * Your Yaho inbox on WhatsApp, through the Cloud API and your own Meta app and business number. Meta calls Yaho's
 * webhook, so it needs the server version, reachable over HTTPS.
 */
export function WhatsAppSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['whatsapp']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['whatsapp']>) => void;
}) {
  const status = useApi<WhatsAppStatus>(
    '/api/whatsapp',
    (e) => e.type === 'changed' && (e.entity === 'whatsapp' || e.entity === 'settings'),
  );
  const st = status.data;
  const [actionError, post] = useAction();
  const set = (patch: Partial<NonNullable<Settings['whatsapp']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.whatsapp(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Create a Meta app with WhatsApp',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://developers.facebook.com/apps/create/')}>
            Open Meta for Developers
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Create an app of type <b className="text-ink">Business</b> and add the <b className="text-ink">WhatsApp</b> product. Under{' '}
          <b className="text-ink">WhatsApp → API Setup</b> use the free test number (add your own number as a recipient) or add a number of
          your own. That number becomes Yaho's; it cannot also be on the WhatsApp app. Copy its <b className="text-ink">Phone Number ID</b>{' '}
          below.
        </p>
      </>,
    ],
    [
      'Make a lasting token',
      <p className="mt-0.5 text-muted">
        The token on API Setup lasts a day. In <b className="text-ink">Business Settings → System Users</b> add a system user, give it the
        app with full control, and generate a token with <code>whatsapp_business_messaging</code> and{' '}
        <code>whatsapp_business_management</code>. Paste it as Access Token. Copy the <b className="text-ink">App Secret</b> from{' '}
        <b className="text-ink">App Settings → Basic</b>.
      </p>,
    ],
    [
      'Point the webhook at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          In <b className="text-ink">WhatsApp → Configuration → Webhook</b> enter this callback URL and verify token, verify, then subscribe
          to <b className="text-ink">messages</b>.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Callback URL
          </Button>
          <Button size="sm" onClick={() => st?.verify_token && void navigator.clipboard.writeText(st.verify_token)}>
            Copy Verify Token
          </Button>
        </div>
        {st?.last_webhook && <p className="mt-1 text-xs text-muted">Last heard from Meta {new Date(st.last_webhook).toLocaleString()}.</p>}
      </>,
    ],
    [
      'Save and say hello',
      <p className="mt-0.5 text-muted">
        Enter your own WhatsApp number, click <b className="text-ink">Save Settings</b>, and send Yaho's number any message from WhatsApp.
        Yaho answers that it is connected. Only your number can use it.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => post('/api/whatsapp/reconnect', status.reload)}>
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
        <Field label="Phone Number ID" hint="WhatsApp → API Setup, under the number.">
          <Input value={value.phone_number_id ?? ''} onChange={(e) => set({ phone_number_id: e.target.value.trim() || undefined })} />
        </Field>
        <Field label="Your WhatsApp Number" hint="With country code. Only this number can use Yaho.">
          <Input
            value={value.number ?? ''}
            placeholder="+46 70 123 45 67"
            onChange={(e) => set({ number: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Access Token" hint="A system user's token.">
          <Input
            type="password"
            value={value.access_token ?? ''}
            placeholder={stored['whatsapp.access_token'] ? 'Value set · type to replace' : 'EAA…'}
            onChange={(e) => set({ access_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="App Secret" hint="App Settings → Basic. Checks that webhook calls come from Meta.">
          <Input
            type="password"
            value={value.app_secret ?? ''}
            placeholder={stored['whatsapp.app_secret'] ? 'Value set · type to replace' : undefined}
            onChange={(e) => set({ app_secret: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field
          label="Waiting Template (Optional)"
          hint={
            <>
              WhatsApp only lets Yaho write freely within 24 hours of your last message. With an approved Utility template whose body has
              one variable, such as “Your Yaho agents have new messages: {'{{1}}'}”, Yaho tells you once when messages are waiting.
            </>
          }
        >
          <Input
            value={value.template ?? ''}
            placeholder="yaho_waiting"
            onChange={(e) => set({ template: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Template Language" hint="The language code it was approved in.">
          <Input
            value={value.template_language ?? ''}
            placeholder="en"
            onChange={(e) => set({ template_language: e.target.value.trim() || undefined })}
          />
        </Field>
      </div>
      <PostChoice label="Post to WhatsApp" value={value.post} onChange={(post) => set({ post })} />
    </Card>
  );
}
