import { Markdown } from '../../components/Markdown.tsx';
import { History } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { ago, Badge, Card } from '../../components/ui/display.tsx';
import { api, useApi, type Agent } from '../../lib/api.ts';
import { agentChanged } from './shared.ts';

export function BriefingHistory({ agent }: { agent: Agent }) {
  const hist = useApi<Array<{ id: number; briefing: string; author: string; created: string }>>(
    `/api/agents/${agent.name}/briefings`,
    agentChanged(agent.name),
  );
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      {hist.data?.map((h, i) => (
        <Card key={h.id} className="p-3">
          <div className="flex items-center gap-2 text-sm">
            <History className="size-4 text-muted" />
            <button type="button" className="cursor-pointer font-medium" onClick={() => setOpen(open === h.id ? null : h.id)}>
              Version {hist.data!.length - i}
            </button>
            <span className="text-muted">
              by {h.author} · {ago(h.created)}
            </span>
            {i === 0 ? (
              <Badge tone="ok" className="ml-auto">
                current
              </Badge>
            ) : (
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void api(`/api/agents/${agent.name}/briefings/${h.id}/revert`, { method: 'POST' })}
              >
                Revert to This
              </Button>
            )}
          </div>
          {open === h.id && <Markdown className="mt-3 border-t border-line pt-3 text-sm">{h.briefing}</Markdown>}
        </Card>
      ))}
    </div>
  );
}
