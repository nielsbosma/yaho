import { Button } from '../../components/ui/button.tsx';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input, Switch } from '../../components/ui/form.tsx';
import { CommandRulesEditor, type CommandRule } from '../../components/CommandRulesEditor.tsx';
import { useApi } from '../../lib/api.ts';
import type { Settings, Upd } from './types.ts';

export function GuardRails({ settings: s, upd }: { settings: Settings; upd: Upd }) {
  return (
    <>
      <Section title="Guard Rails">
        <Card className="grid gap-4 p-4 md:grid-cols-2">
          <Field label="Global Spend Cap (USD)" hint="When total spend reaches it, no job starts and running jobs stop.">
            <Input
              type="number"
              min="0"
              value={s.global_spend_cap_usd}
              onChange={(e) => upd((d) => void (d.global_spend_cap_usd = Number(e.target.value)))}
            />
          </Field>
          <SandboxMode value={s.sandbox} onChange={(v) => upd((d) => void (d.sandbox = v))} />
        </Card>
      </Section>
      <CommandRules value={s.command_rules} onChange={(v) => upd((d) => void (d.command_rules = v))} />
    </>
  );
}

/**
 * Run harnesses in their sandbox: shell commands and file edits may only write in the agent's workspace (and the temp
 * folder). Unset follows the version: on in the server version, off on the desktop.
 */
function SandboxMode({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean) => void }) {
  const info = useApi<{ default: boolean; problems: Record<string, string | null> }>(
    '/api/sandbox',
    (e) => e.type === 'changed' && e.entity === 'settings',
  );
  const on = value ?? info.data?.default ?? false;
  const problems = Object.entries(info.data?.problems ?? {}).filter(([, p]) => p) as Array<[string, string]>;
  return (
    <div className="space-y-2 md:col-span-2">
      <label className="flex items-start gap-3 text-sm">
        <Switch checked={on} label="Sandbox Mode" onChange={onChange} />
        <span>
          Sandbox Mode
          <span className="block text-xs text-muted">
            Agents' commands and file edits may only change their own workspace; the rest of the computer is read-only to them. The network
            stays open. {info.data?.default ? 'On by default in the server version.' : 'Off by default on the desktop.'}
          </span>
        </span>
      </label>
      {on &&
        problems.map(([h, p]) => (
          <p key={h} className="text-xs text-warn">
            {p}: jobs on {h} fail while Sandbox Mode is on.
          </p>
        ))}
    </div>
  );
}

/**
 * Command Rules: shell commands checked before they run. Off unless turned on; the rules start as the default list
 * (an unset list means the defaults, so they follow Yaho's until edited).
 */
function CommandRules({
  value,
  onChange,
}: {
  value: { enabled?: boolean; rules?: CommandRule[] } | undefined;
  onChange: (v: { enabled?: boolean; rules?: CommandRule[] }) => void;
}) {
  const defaults = useApi<CommandRule[]>('/api/command-rules/defaults');
  const on = !!value?.enabled;
  const rules = value?.rules ?? defaults.data ?? [];
  return (
    <Section title="Command Rules">
      <Card className="space-y-4 p-4">
        <label className="flex items-start gap-3 text-sm">
          <Switch checked={on} label="Command Rules" onChange={(v) => onChange({ ...value, enabled: v })} />
          <span>
            Check Agents' Commands
            <span className="block text-xs text-muted">
              Every shell command an agent runs is checked against these rules first. Block refuses it. Ask pauses the job and asks you in
              the inbox (Allow once, Always allow or Deny); the job resumes with your answer. Allow lets a command through that an Ask rule
              would hold. Block always wins. Patterns use * as a wildcard and match the whole command; write /…/ for a regular expression.
              The rules catch mistakes, not a determined agent: a command can be written in ways no rule foresees, so keep Sandbox Mode on
              as well.
            </span>
          </span>
        </label>
        {on && (
          <>
            <CommandRulesEditor rules={rules} onChange={(r) => onChange({ ...value, rules: r })} />
            {value?.rules && (
              <Button size="sm" variant="link" onClick={() => onChange({ ...value, rules: undefined })}>
                Reset to Defaults
              </Button>
            )}
          </>
        )}
      </Card>
    </Section>
  );
}
