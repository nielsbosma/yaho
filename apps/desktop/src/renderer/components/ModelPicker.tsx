import { ArrowUp, Check, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../lib/api.ts';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';
import { Badge } from './ui/display.tsx';

const PROVIDERS: Array<[RegExp, string]> = [
  [/^claude/i, 'Anthropic'],
  [/^(gpt|o\d|chatgpt)/i, 'OpenAI'],
  [/^gemini/i, 'Google'],
  [/^(deepseek)/i, 'DeepSeek'],
  [/^(qwen)/i, 'Qwen'],
  [/^(kimi)/i, 'Moonshot'],
  [/^(glm)/i, 'Zhipu'],
  [/^(mistral|codestral)/i, 'Mistral'],
  [/^(llama)/i, 'Meta'],
];
export const providerOf = (model: string) => PROVIDERS.find(([re]) => re.test(model))?.[1] ?? 'Other';

/**
 * Pick the models an agent may use, from what the LiteLLM proxy offers. Order matters: the first is the one jobs
 * run with, the last also serves Claude Code's small background calls.
 */
export function ModelPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const available = useApi<{ models: string[] }>('/api/settings/litellm/models');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const models = available.data?.models ?? [];
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => models.filter((m) => !value.includes(m) && (!q || m.toLowerCase().includes(q) || providerOf(m).toLowerCase().includes(q))),
    [models, value, q],
  );
  const groups = useMemo(() => {
    const g = new Map<string, string[]>();
    for (const m of matches) g.set(providerOf(m), [...(g.get(providerOf(m)) ?? []), m]);
    return [...g.entries()].sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)));
  }, [matches]);
  const flat = groups.flatMap(([, ms]) => ms);
  // Typing a name the proxy did not list still works: LiteLLM may route names it does not advertise.
  const custom = q && !models.some((m) => m.toLowerCase() === q) && !value.includes(query.trim()) ? query.trim() : null;

  const add = (m: string) => {
    onChange([...value, m]);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="space-y-2">
      {value.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {value.map((m, i) => (
            <li key={m} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="w-16 shrink-0 text-xs text-muted">{providerOf(m)}</span>
              <code className="min-w-0 flex-1 truncate">{m}</code>
              {i === 0 ? (
                <Badge tone="accent">Primary</Badge>
              ) : (
                <button
                  type="button"
                  title="Make Primary"
                  onClick={() => onChange([m, ...value.filter((x) => x !== m)])}
                  className="cursor-pointer rounded p-1 text-muted hover:bg-hover hover:text-ink"
                >
                  <ArrowUp className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                title="Remove"
                onClick={() => onChange(value.filter((x) => x !== m))}
                className="cursor-pointer rounded p-1 text-muted hover:bg-hover hover:text-danger"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted">
          No models yet: the default models apply.
        </div>
      )}

      <div ref={box} className="relative">
        <Button size="sm" onClick={() => setOpen(!open)}>
          <Plus /> Add Model
        </Button>
        {open && (
          <div className="absolute z-40 mt-1 w-80 overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search className="size-4 text-muted" />
              <input
                ref={input}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                  if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, flat.length - 1));
                  if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const pick = flat[active] ?? custom;
                    if (pick) add(pick);
                  }
                }}
                placeholder="Search models…"
                className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {available.error && (
                <div className="px-3 py-2 text-xs text-danger">Could not list models from LiteLLM: {available.error}</div>
              )}
              {!available.data && !available.error && <div className="px-3 py-2 text-xs text-muted">Loading models…</div>}
              {groups.map(([provider, ms]) => (
                <div key={provider}>
                  <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{provider}</div>
                  {ms.map((m) => {
                    const i = flat.indexOf(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => add(m)}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm',
                          i === active && 'bg-hover',
                        )}
                      >
                        <code className="flex-1 truncate">{m}</code>
                        {i === active && <Check className="size-3.5 text-muted" />}
                      </button>
                    );
                  })}
                </div>
              ))}
              {custom && (
                <button
                  type="button"
                  onClick={() => add(custom)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-muted',
                    !flat.length && 'bg-hover',
                  )}
                >
                  <Plus className="size-3.5" /> Use <code className="text-ink">{custom}</code>
                </button>
              )}
              {available.data && !flat.length && !custom && (
                <div className="px-3 py-2 text-xs text-muted">Every listed model is already added.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
