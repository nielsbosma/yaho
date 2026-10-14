import { AlertTriangle, CheckCircle2, ChevronRight, Webhook as WebhookIcon } from 'lucide-react';
import { BrandLogo } from '../../components/BrandLogo.tsx';
import { cn } from '../../components/ui/cn.ts';
import { useApi } from '../../lib/api.ts';
import { href } from '../../lib/router.ts';
import { composioSummary, useComposioHealth } from './Composio.tsx';
import { SUMMARY, type State, type Summary } from './shared.tsx';

export type Id = 'slack' | 'telegram' | 'whatsapp' | 'email' | 'sms' | 'webhooks' | 'browser' | 'composio';

/** Every integration: what it is, its logo, and whether it needs Yaho reachable from the internet (the server version). */
export const INTEGRATIONS: Array<{
  id: Id;
  name: string;
  brand: string;
  about: string;
  online?: boolean;
  status?: string;
  entity?: string;
}> = [
  {
    id: 'slack',
    name: 'Slack',
    brand: 'slack',
    about: 'Your inbox as Slack DMs, answered from Slack.',
    status: '/api/slack',
    entity: 'slack',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    brand: 'telegram',
    about: 'Your inbox in a chat with your own Telegram bot.',
    status: '/api/telegram',
    entity: 'telegram',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    brand: 'whatsapp',
    about: 'Your inbox on WhatsApp, through your own business number.',
    online: true,
    status: '/api/whatsapp',
    entity: 'whatsapp',
  },
  {
    id: 'email',
    name: 'Email',
    brand: 'resend',
    about: 'Agents get their own address through Resend and act on replies.',
    online: true,
    status: '/api/resend',
    entity: 'resend',
  },
  {
    id: 'sms',
    name: 'SMS',
    brand: 'twilio',
    about: 'Agents text people from a Twilio number and act on replies.',
    online: true,
    status: '/api/twilio',
    entity: 'twilio',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    brand: 'webhook',
    about: 'Any service can start an agent by posting to its own signed URL.',
    online: true,
    status: '/api/webhooks',
    entity: 'webhooks',
  },
  {
    id: 'browser',
    name: 'Browser',
    brand: 'browser',
    about: 'A real browser for agents: open pages, sign in, click and fill in forms.',
    status: '/api/browser',
    entity: 'browser',
  },
  { id: 'composio', name: 'Composio', brand: 'composio', about: 'Gmail, Calendar, GitHub and hundreds more apps for agents.' },
];

/** A brand's mark, or for Webhooks (no brand) the generic icon on the same tile. */
export function IntegrationLogo({ brand, className }: { brand: string; className?: string }) {
  if (brand !== 'webhook') return <BrandLogo brand={brand} className={className} />;
  return (
    <span
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-[#3b3b3b]', className)}
    >
      <WebhookIcon className="size-5" />
    </span>
  );
}

/** One line of the list: logo, name, what it does, and how it stands. */
export function IntegrationRow({ def, available }: { def: (typeof INTEGRATIONS)[number]; available: boolean }) {
  const st = useApi<never>(
    available && def.status ? def.status : null,
    (e) => e.type === 'changed' && (e.entity === def.entity || e.entity === 'settings'),
  );
  const composio = useComposioHealth(available && def.id === 'composio');
  const summary: Summary | undefined = !available
    ? undefined
    : def.id === 'composio'
      ? composio && composioSummary(composio)
      : st.data
        ? SUMMARY[def.id as Exclude<Id, 'composio'>](st.data)
        : undefined;
  return (
    <a href={href('settings', 'integrations', def.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-hover/60">
      <IntegrationLogo brand={def.brand} className={cn(!available && 'opacity-50 grayscale')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {def.name}
          {!available && <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-normal text-muted">Server version only</span>}
        </div>
        <div className="truncate text-xs text-muted" title={summary?.line || undefined}>
          {!available ? 'Not available on the desktop version of Yaho.' : summary && summary.state !== 'off' ? summary.line : def.about}
        </div>
      </div>
      <StateMark state={available ? summary?.state : undefined} />
      <ChevronRight className="size-4 shrink-0 text-muted" />
    </a>
  );
}

export function StateMark({ state }: { state?: State }) {
  if (state === 'ok') return <CheckCircle2 className="size-5 shrink-0 text-ok" aria-label="Set up" />;
  if (state === 'warn') return <AlertTriangle className="size-5 shrink-0 text-warn" aria-label="Needs attention" />;
  if (state === 'error') return <AlertTriangle className="size-5 shrink-0 text-danger" aria-label="Not working" />;
  return <span className="shrink-0 text-xs text-muted">{state === 'off' ? 'Not set up' : ''}</span>;
}
