import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Select, Switch } from '../../components/ui/form.tsx';
import type { Settings, Upd } from './types.ts';

export function Updates({ settings: s, upd }: { settings: Settings; upd: Upd }) {
  return (
    <Section title="Updates">
      <Card className="space-y-4 p-4">
        <Switch
          checked={s.updates?.auto !== false}
          onChange={(v) => upd((d) => void (d.updates = { ...d.updates, auto: v }))}
          label="Check for Updates Automatically"
        />
        <Field label="Update Channel" hint="Preview gets new versions first, before they are released to everyone.">
          <Select
            value={s.updates?.channel ?? 'latest'}
            onChange={(e) => upd((d) => void (d.updates = { ...d.updates, channel: e.target.value as 'latest' | 'next' }))}
          >
            <option value="latest">Stable</option>
            <option value="next">Preview</option>
          </Select>
        </Field>
      </Card>
    </Section>
  );
}
