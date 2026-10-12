import type { ProviderConfig, Settings } from './config.ts';

/**
 * The model providers Yaho knows (providerApi.ts does the work). Those not available yet show as coming. When one is built, its settings go in a `providers:` list (id, kind, url) with its key in Dopbase
 * as PROVIDER_<ID>_API_KEY, and model names take the form <provider>/<model> (a bare name means the default provider).
 */
export interface ProviderInfo {
  kind: string;
  label: string;
  available: boolean;
  /** One line for the picker. */
  description: string;
}

export const PROVIDERS: ProviderInfo[] = [
  { kind: 'litellm', label: 'LiteLLM', available: true, description: 'Your LiteLLM proxy, in front of any model. Budgets are enforced per job.' },
  { kind: 'anthropic', label: 'Anthropic', available: true, description: 'Claude models with an Anthropic API key.' },
  { kind: 'openrouter', label: 'OpenRouter', available: true, description: 'Claude models through your OpenRouter key; more models in the chat.' },
  { kind: 'opper', label: 'Opper.AI', available: true, description: 'Hundreds of models through Opper, hosted in the EU.' },
  { kind: 'openai', label: 'OpenAI', available: true, description: 'GPT models with an OpenAI API key.' },
  { kind: 'berget', label: 'Berget.AI', available: true, description: 'Open models hosted in the EU by Berget.' },
];

/** The provider for model names without one: default_provider, or the first. */
export function defaultProvider(s: Settings): ProviderConfig {
  const p = s.providers.find((x) => x.id === s.default_provider) ?? s.providers[0];
  if (!p) throw new Error('no model provider is set up; add one in Settings');
  return p;
}

/**
 * Which provider serves a model name, and the name it knows the model by. "<id>/<model>" names its provider when <id>
 * is a configured provider; anything else (including LiteLLM names like openai/gpt-4o) goes to the default provider
 * as it is.
 */
export function resolveModel(s: Settings, name: string): { provider: ProviderConfig; model: string } {
  const slash = name.indexOf('/');
  if (slash > 0) {
    const provider = s.providers.find((p) => p.id === name.slice(0, slash));
    if (provider) return { provider, model: name.slice(slash + 1) };
  }
  return { provider: defaultProvider(s), model: name };
}

/** The first LiteLLM provider, for what needs one when no provider is named. */
export function litellmProvider(s: Settings): ProviderConfig & { url: string } {
  const p = s.providers.find((x) => x.kind === 'litellm');
  if (!p) throw new Error('no LiteLLM provider is set up; add one in Settings');
  return p as ProviderConfig & { url: string };
}
