import { BrandLogo } from '../../components/BrandLogo.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input, Switch } from '../../components/ui/form.tsx';
import { ClaudeCheckPanel } from '../onboarding.tsx';
import type { Settings } from './types.ts';

const HARNESSES = [
  { id: 'claude-code', label: 'Claude Code', logo: 'claude', about: "Anthropic's agent. Works with every model provider." },
  {
    id: 'codex',
    label: 'Codex',
    logo: 'openai',
    about: "OpenAI's agent. Needs a provider with OpenAI's Responses API: OpenAI, LiteLLM, Opper or OpenRouter.",
  },
] as const;

/**
 * The harnesses agents run in, as cards like Model Providers: each with its command, a check (installed, recent, a real
 * answer through your provider), and which one new agents use (each agent can still pick its own).
 */
export function Harnesses({
  settings: s,
  upd,
  desktop,
}: {
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  desktop: boolean;
}) {
  return (
    <Section title="Harnesses">
      <div className="space-y-3">
        {HARNESSES.map((h) => {
          const cfg = s.harnesses[h.id] ?? { command: h.id === 'codex' ? 'codex' : 'claude' };
          const isDefault = s.defaults.harness === h.id;
          return (
            <Card key={h.id} className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <BrandLogo brand={h.logo} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{h.label}</div>
                  <div className="text-xs text-muted">{isDefault ? 'Default for new agents' : h.about}</div>
                </div>
                {!isDefault && (
                  <Button size="sm" onClick={() => upd((d) => void (d.defaults.harness = h.id))}>
                    Make Default
                  </Button>
                )}
              </div>
              <Field label="Command" hint="What Yaho runs for this harness: a name on PATH or a full path.">
                <Input
                  value={cfg.command}
                  onChange={(e) => upd((d) => void (d.harnesses[h.id] = { ...d.harnesses[h.id], command: e.target.value }))}
                />
              </Field>
              <ClaudeCheckPanel auto={false} harness={h.id} />
              {h.id === 'claude-code' && desktop && (
                <label className="flex items-start gap-3 border-t border-line pt-4 text-sm">
                  <Switch
                    checked={!!cfg.args?.includes('--chrome')}
                    label="Agents Can Use Chrome"
                    onChange={(v) =>
                      upd((d) => {
                        const x = d.harnesses['claude-code']!;
                        const rest = (x.args ?? []).filter((a) => a !== '--chrome');
                        x.args = v ? [...rest, '--chrome'] : rest;
                      })
                    }
                  />
                  <span>
                    Agents Can Use Chrome
                    <span className="block text-xs text-muted">
                      Starts Claude Code with <code>--chrome</code>, so every agent gets the Claude in Chrome browser tools. Needs Chrome
                      open with the Claude extension signed in. Agents act in your real browser, with your logins.
                    </span>
                  </span>
                </label>
              )}
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
