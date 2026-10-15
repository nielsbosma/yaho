import { Markdown } from '../../components/Markdown.tsx';
import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Dialog } from '../../components/ui/dialog.tsx';
import { ago, Badge, Card, money, Section } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { api, type Agent } from '../../lib/api.ts';
import { href } from '../../lib/router.ts';
import { JobList } from '../jobs.tsx';

export function AgentOverview({ agent: a, onError }: { agent: Agent; onError: (e: string | null) => void }) {
  const [raise, setRaise] = useState(false);
  const [budget, setBudget] = useState(String(a.budget_usd));
  const pct = Math.min(100, ((a.spent_usd ?? 0) / Math.max(0.0001, a.budget_usd)) * 100);
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Budget</div>
          <div className="mt-1 font-serif text-2xl">
            {money(a.spent_usd)} <span className="text-base text-muted">of {money(a.budget_usd)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
            <div className={cn('h-full', pct >= 100 ? 'bg-danger' : 'bg-accent')} style={{ width: `${pct}%` }} />
          </div>
          <Button size="sm" className="mt-3" onClick={() => setRaise(true)}>
            <Wallet /> Change Budget
          </Button>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Jobs</div>
          <div className="mt-1 font-serif text-2xl">
            {a.running ?? 0} <span className="text-base text-muted">running</span> · {a.queued ?? 0}{' '}
            <span className="text-base text-muted">queued</span>
          </div>
          <div className="mt-2 text-xs text-muted">max {a.max_parallel} in parallel</div>
          {a.upcoming?.map((u) => (
            <div key={u.at + u.type} className="mt-1 text-xs text-muted" title={new Date(u.at).toLocaleString()}>
              Next {u.type === 'delay' ? 'wake-up' : u.type === 'dream' ? 'dream' : 'cron run'} {ago(u.at)}
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Works On</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {a.projects.map((p) => (
              <a key={p} href={href('projects', p)}>
                <Badge tone="accent">{p}</Badge>
              </a>
            ))}
            {a.resources.map((r) => (
              <a key={r} href={href('resources', r)}>
                <Badge tone="info">{r}</Badge>
              </a>
            ))}
            {!a.projects.length && !a.resources.length && <span className="text-sm text-muted">No projects or resources</span>}
          </div>
        </Card>
      </div>
      <Section title="Briefing">
        <Card className="max-h-72 overflow-auto p-4 text-sm">
          {a.briefing ? <Markdown>{a.briefing}</Markdown> : <span className="text-muted">Empty</span>}
        </Card>
      </Section>
      <Section title="Jobs">
        <JobList agent={a.name} />
      </Section>
      <Dialog
        open={raise}
        onClose={() => setRaise(false)}
        title="Change Budget"
        footer={
          <>
            <Button onClick={() => setRaise(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                onError(null);
                try {
                  await api(`/api/agents/${a.name}`, { method: 'PATCH', body: { budget_usd: Number(budget) } });
                  setRaise(false);
                } catch (e) {
                  onError((e as Error).message);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Field
          label="Budget in USD"
          hint={`Spent so far: ${money(a.spent_usd)}. Jobs stopped by the budget can be continued after raising it.`}
        >
          <Input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </>
  );
}
