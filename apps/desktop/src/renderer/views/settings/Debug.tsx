import { Card, Section } from '../../components/ui/display.tsx';
import { Switch } from '../../components/ui/form.tsx';
import type { Settings, Upd } from './types.ts';

/** Shown in debug mode only. */
export function Debug({ settings: s, upd }: { settings: Settings; upd: Upd }) {
  return (
    <Section title="Debug">
      <Card className="space-y-4 p-4">
        <p className="text-sm text-muted">Shown because Yaho runs in debug mode (the dev session, or YAHO_DEBUG=1).</p>
        <label className="flex items-start gap-3 text-sm">
          <Switch
            checked={s.ideas?.enabled !== false}
            label="Agents File Ideas for Yaho"
            onChange={(v) => upd((d) => void (d.ideas = { ...d.ideas, enabled: v }))}
          />
          <span>
            Agents File Ideas for Yaho as GitHub Issues
            <span className="block text-xs text-muted">
              When something about Yaho holds an agent back, it suggests a feature with <code>yaho idea</code>. Filed with your{' '}
              <code>gh</code> login; without it, the idea comes to your inbox with a link instead. At most 3 per agent a day.
            </span>
          </span>
        </label>
      </Card>
    </Section>
  );
}
