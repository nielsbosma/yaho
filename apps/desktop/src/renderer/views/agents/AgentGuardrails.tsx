import { CommandRulesEditor } from '../../components/CommandRulesEditor.tsx';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import type { Agent } from '../../lib/api.ts';

/** Limits on agent-triggered jobs, and this agent's own Command Rules. */
export function AgentGuardrails({ draft, set }: { draft: Agent; set: <K extends keyof Agent>(k: K, v: Agent[K]) => void }) {
  return (
    <Section title="Guardrails">
      <Card className="space-y-3 p-4">
        <p className="text-sm text-muted">
          Limits on jobs started by other agents' messages, so agents cannot keep waking each other. Empty means no limit.
        </p>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Jobs per Hour" hint="Agent-triggered jobs.">
            <Input
              type="number"
              min="0"
              value={draft.guardrails.rate_per_hour ?? ''}
              onChange={(e) =>
                set('guardrails', { ...draft.guardrails, rate_per_hour: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Cooldown (Seconds)" hint="Between agent-triggered jobs.">
            <Input
              type="number"
              min="0"
              value={draft.guardrails.cooldown_seconds ?? ''}
              onChange={(e) =>
                set('guardrails', { ...draft.guardrails, cooldown_seconds: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Hop Limit" hint="How long a chain of agent messages may get.">
            <Input
              type="number"
              min="0"
              value={draft.guardrails.hop_limit ?? ''}
              onChange={(e) =>
                set('guardrails', { ...draft.guardrails, hop_limit: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
        </div>
        <Field
          label="Command Rules"
          hint="Checked with the ones in Settings → Guard Rails, when Command Rules are on there. Allow here lets this agent run what others must ask for."
          group
        >
          <CommandRulesEditor
            rules={draft.guardrails.command_rules ?? []}
            onChange={(r) => set('guardrails', { ...draft.guardrails, command_rules: r.length ? r : undefined })}
          />
        </Field>
      </Card>
    </Section>
  );
}
