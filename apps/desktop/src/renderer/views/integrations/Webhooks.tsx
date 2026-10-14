import { Button } from '../../components/ui/button.tsx';
import { ago, Card } from '../../components/ui/display.tsx';
import { VERIFY_LABEL, webhookUrl } from '../../components/WebhookTriggers.tsx';
import { useApi, type Webhook } from '../../lib/api.ts';
import { href } from '../../lib/router.ts';
import { StatusLine, SUMMARY } from './shared.tsx';

/** Every agent's webhooks in one list. They are added and changed in each agent's definition, under When It Runs. */
export function WebhooksSettings({ server }: { server: boolean }) {
  const list = useApi<Webhook[]>('/api/webhooks', (e) => e.type === 'changed' && (e.entity === 'webhooks' || e.entity === 'agents'));
  const summary = SUMMARY.webhooks(list.data ?? undefined);
  return (
    <Card className="space-y-4 p-4">
      {list.data && <StatusLine {...summary} />}
      <p className="text-sm text-muted">
        A webhook is a trigger: each delivery to its URL starts a job for its agent, with the payload saved in the agent's workspace and
        shown in its inbox. Add one in an agent's <b className="text-ink">Definition</b> under <b className="text-ink">When It Runs</b>.
        Repeated deliveries are dropped, and each webhook takes a limited number per hour.
      </p>
      {!!list.data?.length && (
        <div className="divide-y divide-line rounded-lg border border-line">
          {list.data.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <a href={href('agents', w.agent, 'edit')} className="font-medium hover:underline">
                  {w.agent} / {w.name}
                </a>
                <div className="truncate text-xs text-muted">
                  {VERIFY_LABEL[w.verify]}
                  {w.paused && ' · paused'}
                  {' · '}
                  {w.last_delivery ? `last delivery ${ago(w.last_delivery)}, ${w.deliveries_24h} in the last day` : 'no deliveries yet'}
                  {w.last_rejected &&
                    ` · last refused ${ago(w.last_rejected.split(' ')[0])}: ${w.last_rejected.split(' ').slice(1).join(' ')}`}
                </div>
              </div>
              <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhookUrl(w.path, server))}>
                Copy URL
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
