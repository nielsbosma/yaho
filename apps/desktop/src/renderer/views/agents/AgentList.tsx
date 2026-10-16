import { useContextMenu, type MenuItem } from '../../components/ContextMenu.tsx';
import { useAgentMenu } from '../../components/AgentMenu.tsx';
import { DataTable, LayoutSwitch, useLayout } from '../../components/ListLayout.tsx';
import { Bot, BotOff, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Badge, Card, Empty, money, PageHeader, StatusBadge } from '../../components/ui/display.tsx';
import { useApi, type Agent } from '../../lib/api.ts';
import { go, href } from '../../lib/router.ts';
import { agentChanged } from './shared.ts';
import { triggerLabel } from './shared.ts';

export function AgentList() {
  const agents = useApi<Agent[]>('/api/agents', agentChanged());
  const menu = useAgentMenu();
  const rowMenu = (a: Agent): MenuItem[] => menu.items(a);
  const cardMenu = useContextMenu();
  const [layout, setLayout] = useLayout('agents');
  return (
    <>
      <PageHeader
        title="Agents"
        sub="Long-lived agents that run on triggers, within a budget."
        actions={
          <>
            <LayoutSwitch value={layout} onChange={setLayout} />
            <Button variant="primary" onClick={() => go('agents', 'new')}>
              <Plus /> New Agent
            </Button>
          </>
        }
      />
      {layout === 'table' && !!agents.data?.length && (
        <div className="p-8">
          <DataTable
            rows={agents.data}
            menu={rowMenu}
            rowKey={(a) => a.name}
            to={(a) => ['agents', a.name]}
            columns={[
              {
                label: 'Agent',
                cell: (a) => (
                  <span className="flex items-center gap-2 font-medium">
                    {a.enabled ? (
                      <Bot className={cn('size-4', a.running ? 'text-info' : 'text-muted')} />
                    ) : (
                      <BotOff className="size-4 text-muted/70" />
                    )}
                    {a.name}
                    {!a.enabled && <Badge>disabled</Badge>}
                  </span>
                ),
              },
              {
                label: 'Status',
                cell: (a) =>
                  a.running ? (
                    <StatusBadge status="running" />
                  ) : a.queued ? (
                    <StatusBadge status="queued" />
                  ) : (
                    <span className="text-muted">idle</span>
                  ),
              },
              {
                label: 'Triggers',
                cell: (a) => <span className="text-muted">{a.triggers.map(triggerLabel).join(' · ') || 'manual only'}</span>,
              },
              { label: 'Models', cell: (a) => <code className="text-xs">{a.models[0] ?? 'default'}</code> },
              { label: 'Unread', cell: (a) => (a.unread ? <Badge tone="accent">{a.unread}</Badge> : null), className: 'text-right' },
              {
                label: 'Spend',
                cell: (a) => (
                  <span className="tabular-nums">
                    {money(a.spent_usd)} / {money(a.budget_usd)}
                  </span>
                ),
                className: 'text-right',
              },
            ]}
          />
        </div>
      )}
      {menu.element}
      {cardMenu.element}
      <div className={cn('grid gap-3 p-8 md:grid-cols-2', layout === 'table' && 'hidden')}>
        {agents.data?.map((a) => (
          <a key={a.name} href={href('agents', a.name)} onContextMenu={(e) => cardMenu.open(e, rowMenu(a))}>
            <Card className="p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                {a.enabled ? (
                  <Bot className={cn('size-4', a.running ? 'text-info' : 'text-muted')} />
                ) : (
                  <BotOff className="size-4 text-muted/70" />
                )}
                <span className="font-medium">{a.name}</span>
                {!a.enabled && <Badge>disabled</Badge>}
                {a.running ? <StatusBadge status="running" /> : null}
                {a.unread ? <Badge tone="accent">{a.unread} unread</Badge> : null}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted">{a.briefing || 'No briefing yet.'}</p>
              <div className="mt-3 flex gap-4 text-xs text-muted">
                <span>
                  {money(a.spent_usd)} / {money(a.budget_usd)}
                </span>
                <span>{a.triggers.map(triggerLabel).join(' · ') || 'manual only'}</span>
              </div>
            </Card>
          </a>
        ))}
      </div>
      {agents.data?.length === 0 && (
        <Empty icon={<Bot />} title="No agents yet">
          Create one, or paste an agent definition in YAML.
        </Empty>
      )}
    </>
  );
}
