import { ArrowLeft, MonitorX } from 'lucide-react';
import { Card, Section } from '../components/ui/display.tsx';
import { href } from '../lib/router.ts';
import { BrowserSettings } from './integrations/Browser.tsx';
import { ComposioSettings } from './integrations/Composio.tsx';
import { EmailSettings } from './integrations/Email.tsx';
import { INTEGRATIONS, IntegrationLogo, IntegrationRow } from './integrations/IntegrationRow.tsx';
import { SlackSettings } from './integrations/Slack.tsx';
import { SmsSettings } from './integrations/Sms.tsx';
import { TelegramSettings } from './integrations/Telegram.tsx';
import { WebhooksSettings } from './integrations/Webhooks.tsx';
import { WhatsAppSettings } from './integrations/WhatsApp.tsx';
import type { Settings } from './settings/types.ts';

/** Integrations need webhooks from the internet, which only the server version gets. */
const DESKTOP_NOTE =
  'Not available on the desktop version of Yaho: it needs webhooks from the internet, which only the server version receives.';

/**
 * Settings → Integrations: every integration with its status (#/settings/integrations), and a click through to one's
 * own settings (#/settings/integrations/<id>). Its fields are saved with Save Settings, like the rest of Settings.
 */
export function Integrations({
  route,
  settings: s,
  upd,
  save,
  server,
}: {
  route: string[];
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  save: () => Promise<boolean>;
  server: boolean;
}) {
  const def = INTEGRATIONS.find((i) => i.id === route[0]);
  if (!def)
    return (
      <Section title="Integrations">
        <Card className="divide-y divide-line">
          {INTEGRATIONS.map((i) => (
            <IntegrationRow key={i.id} def={i} available={!i.online || server} />
          ))}
        </Card>
      </Section>
    );
  const available = !def.online || server;
  const stored = s.secrets_set ?? {};
  return (
    <section className="space-y-4">
      <a href={href('settings', 'integrations')} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All Integrations
      </a>
      <h2 className="flex items-center gap-3 text-lg font-semibold">
        <IntegrationLogo brand={def.brand} />
        {def.name}
      </h2>
      {!available ? (
        <Card className="flex items-start gap-3 p-4 text-sm text-muted">
          <MonitorX className="mt-0.5 size-4 shrink-0" />
          <span>{DESKTOP_NOTE}</span>
        </Card>
      ) : def.id === 'slack' ? (
        <SlackSettings value={s.slack ?? {}} stored={stored} onChange={(v) => upd((d) => void (d.slack = v))} />
      ) : def.id === 'telegram' ? (
        <TelegramSettings value={s.telegram ?? {}} stored={stored} onChange={(v) => upd((d) => void (d.telegram = v))} />
      ) : def.id === 'whatsapp' ? (
        <WhatsAppSettings value={s.whatsapp ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.whatsapp = v))} />
      ) : def.id === 'email' ? (
        <EmailSettings value={s.resend ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.resend = v))} />
      ) : def.id === 'browser' ? (
        <BrowserSettings value={s.browser ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.browser = v))} />
      ) : def.id === 'sms' ? (
        <SmsSettings value={s.twilio ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.twilio = v))} />
      ) : def.id === 'webhooks' ? (
        <WebhooksSettings server={server} />
      ) : (
        <ComposioSettings settings={s} upd={upd} save={save} />
      )}
    </section>
  );
}
