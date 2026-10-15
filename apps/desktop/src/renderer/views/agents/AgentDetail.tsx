import { WorkspaceBrowser } from '../../components/WorkspaceBrowser.tsx';
import { RunDialog } from '../../components/AgentMenu.tsx';
import { Play, Sparkles } from 'lucide-react';
import { chatAboutAgent } from '../../lib/chat.ts';
import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Badge, Empty, ErrorNote, PageHeader, Tabs } from '../../components/ui/display.tsx';
import { Switch } from '../../components/ui/form.tsx';
import { api, useApi, type Agent } from '../../lib/api.ts';
import { go, href } from '../../lib/router.ts';
import { AgentInbox } from '../inbox.tsx';
import { agentChanged } from './shared.ts';
import { triggerLabel } from './shared.ts';
import { AgentOverview } from './AgentOverview.tsx';
import { AgentEditor } from './AgentEditor.tsx';
import { BriefingHistory } from './BriefingHistory.tsx';
import { AgentArtifacts } from './AgentArtifacts.tsx';
import { AgentVersions } from './AgentVersions.tsx';

export function AgentDetail({ name, tab, sub }: { name: string; tab: string; sub?: string }) {
  const agent = useApi<Agent>(`/api/agents/${encodeURIComponent(name)}`, agentChanged(name));
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const a = agent.data;
  if (agent.error) return <Empty title="Agent not found">{agent.error}</Empty>;
  if (!a) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {/* Header and tabs stay put while the content scrolls. */}
      <div className="sticky top-0 z-20 bg-bg">
        <PageHeader
          crumbs={[{ label: 'Agents', to: href('agents') }]}
          title={
            <span className="flex items-center gap-3">
              {a.name}
              {!a.enabled && <Badge>disabled</Badge>}
            </span>
          }
          sub={`${a.harness} · ${a.models.join(', ') || 'no models'} · ${a.triggers.map(triggerLabel).join(' · ') || 'manual only'}`}
          actions={
            <>
              <label className="mr-2 flex items-center gap-2 text-sm text-muted">
                Enabled
                <Switch
                  checked={a.enabled}
                  label="Enabled"
                  onChange={(v) => void act(() => api(`/api/agents/${a.name}`, { method: 'PATCH', body: { enabled: v } }))}
                />
              </label>
              <Button onClick={() => chatAboutAgent(a.name)} title="Ask about this agent, or have Yaho change it">
                <Sparkles /> Chat About Agent
              </Button>
              <Button
                variant="primary"
                onClick={() => setRunning(true)}
                title={a.enabled ? undefined : 'Disabled: it only runs when you start it'}
              >
                <Play /> Run Now
              </Button>
            </>
          }
        />
        <Tabs
          value={tab}
          onChange={(t) => go('agents', a.name, t)}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'edit', label: 'Definition' },
            { id: 'inbox', label: 'Inbox' },
            { id: 'briefings', label: 'Briefing History' },
            { id: 'workspace', label: 'Workspace' },
            { id: 'versions', label: 'Versions' },
            { id: 'artifacts', label: 'Artifacts' },
          ]}
        />
      </div>
      <div className="space-y-6 p-8">
        <ErrorNote>{error}</ErrorNote>
        {tab === 'overview' && <AgentOverview agent={a} onError={setError} />}
        {tab === 'edit' && <AgentEditor existing={a} />}
        {tab === 'inbox' && <AgentInbox agent={a.name} />}
        {tab === 'briefings' && <BriefingHistory agent={a} />}
        {tab === 'workspace' && <WorkspaceBrowser agent={a.name} />}
        {tab === 'versions' && <AgentVersions agent={a} open={sub} />}
        {tab === 'artifacts' && <AgentArtifacts agent={a.name} />}
      </div>
      <RunDialog agent={a} open={running} onClose={() => setRunning(false)} />
    </>
  );
}
