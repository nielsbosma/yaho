import { Check as CheckIcon, Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../../components/ui/cn.ts';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field } from '../../components/ui/form.tsx';
import { PALETTES, usePalette, useTheme, type Theme } from '../../lib/theme.ts';

/** Light or dark, and the color theme. Applied at once and kept on this device, not in settings.yaml. */
export function Appearance() {
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = usePalette();
  const modes: Array<[Theme, typeof Sun, string]> = [
    ['system', Monitor, 'Match System'],
    ['light', Sun, 'Light'],
    ['dark', Moon, 'Dark'],
  ];
  return (
    <Section title="Appearance">
      <Card className="space-y-5 p-4">
        <Field label="Mode">
          <div className="flex w-fit rounded-lg bg-hover p-0.5 text-sm" role="radiogroup" aria-label="Mode">
            {modes.map(([t, Icon, label]) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 [&_svg]:size-3.5',
                  theme === t ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Color Theme" hint="Buttons, links, charts and highlights. Each has a light and a dark shade.">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color theme">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={palette === p.id}
                onClick={() => setPalette(p.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg border py-1.5 pr-3 pl-1.5 text-sm transition-colors',
                  palette === p.id ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong',
                )}
              >
                <span className="flex size-6 overflow-hidden rounded-md">
                  <span className="flex-1" style={{ background: p.light }} />
                  <span className="flex-1" style={{ background: p.dark }} />
                </span>
                {p.label}
                {palette === p.id && <CheckIcon className="size-3.5 text-accent" />}
              </button>
            ))}
          </div>
        </Field>
      </Card>
    </Section>
  );
}
