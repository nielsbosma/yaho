import { useEffect, useState } from 'react';
import { cn } from './ui/cn.ts';
import { Input, Select, Textarea } from './ui/form.tsx';

type Mode = 'manual' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const MODES: Array<[Mode, string]> = [
  ['manual', 'Manual'],
  ['hourly', 'Hourly'],
  ['daily', 'Daily'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
  ['custom', 'Custom'],
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Parsed {
  mode: Mode;
  hour: number;
  minute: number;
  day: number;
}

const num = (s: string, max: number) => (/^\d+$/.test(s) && Number(s) <= max ? Number(s) : null);

/** Recognise the crons the picker writes; anything else is Custom. */
function parse(crons: string[]): Parsed {
  const base: Parsed = { mode: 'custom', hour: 9, minute: 0, day: 1 };
  if (!crons.length) return { ...base, mode: 'manual' };
  if (crons.length > 1) return base;
  const f = crons[0]!.trim().split(/\s+/);
  if (f.length !== 5) return base;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  const minute = num(mi, 59);
  if (minute === null || dom !== '*' || mon !== '*') return base;
  if (h === '*' && dow === '*') return { ...base, mode: 'hourly', minute };
  const hour = num(h, 23);
  if (hour === null) return base;
  if (dow === '*') return { mode: 'daily', hour, minute, day: 1 };
  if (dow === '1-5') return { mode: 'weekdays', hour, minute, day: 1 };
  const day = num(dow, 7);
  if (day !== null) return { mode: 'weekly', hour, minute, day: day % 7 };
  return base;
}

function build(p: Parsed): string[] {
  switch (p.mode) {
    case 'manual':
      return [];
    case 'hourly':
      return [`${p.minute} * * * *`];
    case 'daily':
      return [`${p.minute} ${p.hour} * * *`];
    case 'weekdays':
      return [`${p.minute} ${p.hour} * * 1-5`];
    case 'weekly':
      return [`${p.minute} ${p.hour} * * ${p.day}`];
    default:
      return [];
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** One cron in words, when it is one of the simple shapes; otherwise the cron itself. */
export function describeCron(cron: string): string {
  const p = parse([cron]);
  const at = `${pad(p.hour)}:${pad(p.minute)}`;
  switch (p.mode) {
    case 'hourly':
      return p.minute ? `Every hour at :${pad(p.minute)}` : 'Every hour';
    case 'daily':
      return `Every day at ${at}`;
    case 'weekdays':
      return `Weekdays at ${at}`;
    case 'weekly':
      return `Every ${DAYS[p.day]} at ${at}`;
    default:
      return `cron ${cron}`;
  }
}

/** Pick when an agent runs: Manual, Hourly, Daily, Weekdays, Weekly, or a Custom cron (one per line). */
export function SchedulePicker({ value, onChange }: { value: string[]; onChange: (crons: string[]) => void }) {
  const [p, setP] = useState<Parsed>(() => parse(value));
  const [custom, setCustom] = useState(value.join('\n'));
  // Follow outside changes (switching agents, editing YAML) without fighting the person's edits.
  const key = value.join('|');
  useEffect(() => {
    if (
      build(p).join('|') !== key &&
      (p.mode !== 'custom' ||
        custom
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join('|') !== key)
    ) {
      setP(parse(value));
      setCustom(value.join('\n'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const update = (next: Partial<Parsed>) => {
    const merged = { ...p, ...next };
    setP(merged);
    if (merged.mode === 'custom') {
      const text = next.mode === 'custom' && !custom.trim() ? '0 9 * * *' : custom;
      setCustom(text);
      onChange(
        text
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    } else onChange(build(merged));
  };
  const time = `${pad(p.hour)}:${pad(p.minute)}`;

  return (
    <div className="space-y-2">
      <div className="flex w-fit flex-wrap gap-0.5 rounded-lg bg-hover p-0.5 text-sm">
        {MODES.map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => update({ mode: m })}
            className={cn('cursor-pointer rounded-md px-2.5 py-1', p.mode === m ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      {(p.mode === 'daily' || p.mode === 'weekdays' || p.mode === 'weekly') && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          At
          <Input
            type="time"
            className="w-32"
            value={time}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (h !== undefined && m !== undefined && !Number.isNaN(h) && !Number.isNaN(m)) update({ hour: h, minute: m });
            }}
          />
          {p.mode === 'weekly' && (
            <>
              On
              <Select className="w-40" value={String(p.day)} onChange={(e) => update({ day: Number(e.target.value) })} aria-label="Day">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>
                    {DAYS[d]}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>
      )}
      {p.mode === 'hourly' && (
        <div className="flex items-center gap-2 text-sm text-muted">
          At minute
          <Input
            type="number"
            min={0}
            max={59}
            className="w-24"
            value={p.minute}
            onChange={(e) => update({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </div>
      )}
      {p.mode === 'custom' && (
        <div className="space-y-1">
          <span className="text-xs text-muted">Cron expression, one per line</span>
          <Textarea
            className="min-h-10 font-mono text-[13px]"
            rows={Math.max(1, custom.split('\n').length)}
            value={custom}
            spellCheck={false}
            onChange={(e) => {
              setCustom(e.target.value);
              onChange(
                e.target.value
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean),
              );
            }}
            placeholder="0 8,17 * * *"
          />
        </div>
      )}
      <p className="text-xs text-muted">
        {p.mode === 'manual'
          ? 'No schedule: it runs when you press Run Now, or on inbox messages if that is on.'
          : value.length
            ? `${value.map(describeCron).join(' · ')}, in this computer's time zone.`
            : 'Add a cron expression.'}
      </p>
    </div>
  );
}
