import { describeCron } from '../../components/SchedulePicker.tsx';
import type { TriggerSpec } from '../../lib/api.ts';

export const agentChanged = (name?: string) => (e: { type: string; entity?: string; name?: string; job?: unknown }) =>
  (e.type === 'changed' && e.entity === 'agents' && (!name || e.name === name)) || e.type === 'job';

export const triggerLabel = (t: TriggerSpec) =>
  'cron' in t ? describeCron(t.cron) : 'webhook' in t ? `webhook ${t.webhook}${t.paused ? ' (paused)' : ''}` : 'on inbox messages';
