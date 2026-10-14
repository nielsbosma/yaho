import { Plus, Trash2 } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Input, Select } from './ui/form.tsx';

export interface CommandRule {
  pattern: string;
  action: 'block' | 'ask' | 'allow';
  note?: string;
}

/** A list of Command Rules: a pattern, what happens when a command matches it, and a note. */
export function CommandRulesEditor({ rules, onChange }: { rules: CommandRule[]; onChange: (rules: CommandRule[]) => void }) {
  const set = (i: number, r: Partial<CommandRule>) => onChange(rules.map((x, j) => (j === i ? { ...x, ...r } : x)));
  return (
    <div className="space-y-2">
      {rules.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_7rem_minmax(0,1.5fr)_auto] gap-2">
          <Input
            value={r.pattern}
            placeholder="git push --force*"
            aria-label="Pattern"
            title={r.pattern}
            className="font-mono text-xs"
            onChange={(e) => set(i, { pattern: e.target.value })}
          />
          <Select value={r.action} aria-label="Action" onChange={(e) => set(i, { action: e.target.value as CommandRule['action'] })}>
            <option value="block">Block</option>
            <option value="ask">Ask</option>
            <option value="allow">Allow</option>
          </Select>
          <Input
            value={r.note ?? ''}
            placeholder="Note"
            aria-label="Note"
            onChange={(e) => set(i, { note: e.target.value || undefined })}
          />
          <Button variant="ghost" size="icon" title="Remove" aria-label="Remove" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...rules, { pattern: '', action: 'ask' }])}>
        <Plus /> Add Rule
      </Button>
    </div>
  );
}
