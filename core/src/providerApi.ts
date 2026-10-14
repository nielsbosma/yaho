import type { ProviderConfig, Settings } from './config.ts';
import { createLitellmKey, deleteLitellmKey, litellmKeySpend, litellmModels, modelPrice, type ModelPrice } from './jobs/litellm.ts';
import { HttpError } from './store.ts';

/**
 * What each kind of model provider does for Yaho: list its models, answer one round of the chat (OpenAI's Chat
 * Completions shape in and out, whatever the provider speaks), and give a job's Claude Code the environment to reach it.
 * Checked against each provider with real keys on 2026-10-12 (.plan/providers.html).
 */

/** Where each kind lives when the provider's settings give no URL. chat: its OpenAI-style base; claude: for Claude Code. */
const ENDPOINTS: Record<string, { chat: string; claude?: string; models: string }> = {
  anthropic: { chat: 'https://api.anthropic.com', models: 'https://api.anthropic.com/v1/models' },
  openrouter: { chat: 'https://openrouter.ai/api/v1', claude: 'https://openrouter.ai/api', models: 'https://openrouter.ai/api/v1/models' },
  opper: { chat: 'https://api.opper.ai/v3/compat', claude: 'https://api.opper.ai/v3/compat', models: 'https://api.opper.ai/v3/compat/models' },
  berget: { chat: 'https://api.berget.ai/v1', models: 'https://api.berget.ai/v1/models' },
  openai: { chat: 'https://api.openai.com/v1', models: 'https://api.openai.com/v1/models' },
};

/** The key for model calls. LiteLLM's master key can make them; OpenRouter's management key cannot. */
const keyOf = (p: ProviderConfig) => (p.kind === 'litellm' ? (p.master_key ?? p.api_key) : p.api_key);
const needKey = (p: ProviderConfig) => {
  const k = keyOf(p);
  if (!k) throw new HttpError(503, `set the API key for ${p.id} in Settings first`);
  return k;
};
const chatBase = (p: ProviderConfig) => (p.kind === 'litellm' ? `${(p.url ?? '').replace(/\/$/, '')}/v1` : (p.url?.replace(/\/$/, '') ?? ENDPOINTS[p.kind]?.chat));

/** Model names this provider offers. */
export async function listModels(s: Settings, p: ProviderConfig): Promise<string[]> {
  if (p.kind === 'litellm') return litellmModels(p);
  const ep = ENDPOINTS[p.kind];
  if (!ep) throw new HttpError(400, `unknown provider kind ${p.kind}`);
  // OpenRouter's list is public: a provider with only a management key still lists its models.
  const key = p.kind === 'openrouter' ? keyOf(p) : needKey(p);
  const headers: Record<string, string> = !key
    ? {}
    : p.kind === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${key}` };
  const res = await fetch(ep.models, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `${p.id}: listing models answered ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data?: Array<{ id: string; capabilities?: { function_calling?: boolean }; model_type?: string }> };
  let list = j.data ?? [];
  // Berget also serves speech, embeddings and rerankers; only chat models with tool calling can run agents.
  if (p.kind === 'berget') list = list.filter((m) => m.capabilities?.function_calling);
  // OpenAI also lists embeddings, speech, images and moderation; agents need chat models.
  if (p.kind === 'openai') list = list.filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(m.id));
  return list.map((m) => m.id).sort();
}

/** Tool-call arguments as an object; a cut-off or broken one becomes {}. */
export const safeJson = (s: string | undefined): Record<string, unknown> => {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

const modelCache = new Map<string, { at: number; models: string[] }>();

/**
 * Every model the configured providers offer, named the way agents and settings name them: plain on the default
 * provider, "<id>/<model>" on the others. provider_of says which provider (its id) each name belongs to. Providers that
 * fail to answer are left out, not fatal. OpenRouter is limited to Anthropic's models, the ones it serves Claude Code.
 */
export async function allModels(s: Settings, defaultId: string): Promise<{ models: string[]; provider_of: Record<string, string>; errors: Record<string, string> }> {
  const models: string[] = [];
  const provider_of: Record<string, string> = {};
  const errors: Record<string, string> = {};
  await Promise.all(
    s.providers.map(async (p) => {
      try {
        const key = `${p.id}|${p.url ?? ''}|${(p.api_key ?? p.master_key ?? '').slice(-6)}`;
        let list = modelCache.get(key);
        if (!list || Date.now() - list.at > 600_000) modelCache.set(key, (list = { at: Date.now(), models: await listModels(s, p) }));
        for (const m of list.models) {
          if (p.kind === 'openrouter' && !m.startsWith('anthropic/')) continue;
          // The default provider's models go unprefixed, unless the name starts like another provider's id
          // ("openai/gpt-5-mini" on LiteLLM), which would send it to that provider.
          const clash = s.providers.some((x) => m.startsWith(`${x.id}/`));
          const name = p.id === defaultId && !clash ? m : `${p.id}/${m}`;
          models.push(name);
          provider_of[name] = p.id;
        }
      } catch (e) {
        errors[p.id] = (e as Error).message;
      }
    }),
  );
  return { models, provider_of, errors };
}

// ---------- the chat: OpenAI Chat Completions in and out ----------

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Part[];
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}
interface OAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}
const clean = (m: OAIMessage): OAIMessage => ({
  role: m.role,
  content: m.content,
  ...(m.tool_calls?.length ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.function.name, arguments: t.function.arguments } })) } : {}),
  ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
});

/** OpenAI's newer models take max_completion_tokens and refuse max_tokens. */
export function forProvider<T extends { max_tokens?: number }>(kind: string, body: T): T | (Omit<T, 'max_tokens'> & { max_completion_tokens?: number }) {
  if (kind !== 'openai' || body.max_tokens === undefined) return body;
  const { max_tokens, ...rest } = body;
  return { ...rest, max_completion_tokens: max_tokens };
}

export interface ChatReply {
  message: OAIMessage;
  /** stop, tool_calls, or length (cut off at the output limit). */
  finish_reason?: string;
  usage?: { input: number; output: number };
}

/** A chat round can be a long answer, but not one that never comes. */
const CHAT_TIMEOUT = 300_000;

/** One round of the assistant's chat on this provider. */
export async function chatRound(
  p: ProviderConfig,
  body: { model: string; messages: OAIMessage[]; tools: OAITool[]; max_tokens: number },
): Promise<ChatReply> {
  const key = needKey(p);
  if (p.kind === 'anthropic') return anthropicChat(chatBase(p)!, key, body);
  const base = chatBase(p);
  if (!base) throw new HttpError(400, `unknown provider kind ${p.kind}`);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    // Only the standard fields: some providers reject what others add to their replies (Berget: function_call: null).
    body: JSON.stringify({ ...forProvider(p.kind, body), messages: body.messages.map(clean), tools: body.tools.length ? body.tools : undefined }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT),
  });
  if (!res.ok) throw new HttpError(502, `${p.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    choices: Array<{ message: OAIMessage; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    message: j.choices[0]!.message,
    finish_reason: j.choices[0]!.finish_reason,
    ...(j.usage ? { usage: { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 } } : {}),
  };
}

/** Anthropic's Messages API behind the same shape: system apart, tool calls as content blocks, tool results as user turns. */
async function anthropicChat(base: string, key: string, body: { model: string; messages: OAIMessage[]; tools: OAITool[]; max_tokens: number }): Promise<ChatReply> {
  const system = body.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n\n');
  type Block = Record<string, unknown>;
  const turns: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = turns.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  const blocksOf = (c: OAIMessage['content']): Block[] => {
    if (!c) return [];
    if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
    return c.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      const m = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'image', source: { type: 'url', url: part.image_url.url } };
    });
  };
  for (const m of body.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }]);
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.function.name, input: safeJson(t.function.arguments) }));
      const blocks = [...blocksOf(m.content), ...calls];
      if (blocks.length) push('assistant', blocks);
    } else push('user', blocksOf(m.content));
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: body.model,
      max_tokens: body.max_tokens,
      ...(system ? { system } : {}),
      messages: turns,
      tools: body.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object' } })),
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT),
  });
  if (!res.ok) throw new HttpError(502, `Anthropic: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as {
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const tool_calls = j.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id!, type: 'function' as const, function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) } }));
  return {
    message: { role: 'assistant', content: text, ...(tool_calls.length ? { tool_calls } : {}) },
    finish_reason: j.stop_reason === 'max_tokens' ? 'length' : j.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
    ...(j.usage ? { usage: { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0 } } : {}),
  };
}

// ---------- jobs: the environment Claude Code gets ----------

export interface JobAccess {
  /** ANTHROPIC_* variables for Claude Code, and YAHO_CODEX_BASE_URL + YAHO_MODEL_KEY for Codex where the provider has OpenAI's Responses API. */
  env: Record<string, string>;
  /** A key minted for this job alone, capped at the agent's remaining budget: its spend so far, and its removal. */
  capped?: { spend(): Promise<number>; release(): Promise<void> };
  /** capped: the provider refuses past the budget. counted: Yaho adds up the reported cost and stops the job. */
  budget: 'capped' | 'counted';
}

/** Where Codex reaches a provider: its Responses API base. Anthropic and Berget have none. */
function responsesBase(p: ProviderConfig): string | undefined {
  if (p.kind === 'litellm') return p.url ? `${p.url.replace(/\/$/, '')}/v1` : undefined;
  if (p.kind === 'openai') return p.url ?? 'https://api.openai.com/v1';
  if (p.kind === 'opper') return p.url ?? 'https://api.opper.ai/v3/compat';
  if (p.kind === 'openrouter') return 'https://openrouter.ai/api/v1';
  return undefined;
}

/** Can a job on this provider run in the given harness? */
export function harnessFits(p: ProviderConfig, harness: string): boolean {
  return harness === 'codex' ? !!responsesBase(p) : true;
}

/** How a job reaches this provider, with the agent's remaining budget: Claude Code's variables, and Codex's. */
export async function jobAccess(
  s: Settings,
  p: ProviderConfig,
  o: { models: string[]; remaining: number; agent: string; job: string; harness: string; bridge?: { apiUrl: string; token: string } },
): Promise<JobAccess> {
  const base = o.harness === 'codex' ? responsesBase(p) : undefined;
  // Codex needs only the Responses address and a key; a provider Claude Code cannot reach here (OpenAI without the
  // bridge) still serves Codex.
  const access = await claudeAccess(s, p, o).catch((e: Error) => {
    if (!base) throw e;
    return { env: {}, budget: 'counted' } as JobAccess;
  });
  if (base) {
    // The same key Claude Code got (a capped one where minted), so budgets hold for Codex too.
    const key = access.env.ANTHROPIC_AUTH_TOKEN || access.env.ANTHROPIC_API_KEY || keyOf(p) || '';
    Object.assign(access.env, { YAHO_CODEX_BASE_URL: base, YAHO_MODEL_KEY: p.kind === 'openai' ? (keyOf(p) ?? '') : key });
  }
  return access;
}

async function claudeAccess(
  s: Settings,
  p: ProviderConfig,
  o: { models: string[]; remaining: number; agent: string; job: string; bridge?: { apiUrl: string; token: string } },
): Promise<JobAccess> {
  if (p.kind === 'litellm') {
    // A capped key per job; a check (no job) uses the plain key and mints nothing.
    if (p.master_key && o.job) {
      const jobKey = await createLitellmKey(p, { maxBudget: o.remaining, models: o.models, agent: o.agent, job: o.job });
      return {
        env: { ANTHROPIC_BASE_URL: p.url ?? '', ANTHROPIC_AUTH_TOKEN: jobKey },
        capped: { spend: () => litellmKeySpend(p, jobKey), release: () => deleteLitellmKey(p, jobKey) },
        budget: 'capped',
      };
    }
    return { env: { ANTHROPIC_BASE_URL: p.url ?? '', ANTHROPIC_AUTH_TOKEN: p.api_key ?? p.master_key ?? '' }, budget: 'counted' };
  }
  // OpenRouter with a management key: a key per job with a credit limit, as LiteLLM's master key does.
  if (p.kind === 'openrouter' && p.master_key && o.job) {
    const minted = await openRouterKey(p.master_key, { name: `yaho-${o.agent}-${o.job}`, limit: o.remaining });
    return {
      env: { ANTHROPIC_BASE_URL: p.url ?? ENDPOINTS.openrouter!.claude!, ANTHROPIC_AUTH_TOKEN: minted.key, ANTHROPIC_API_KEY: '' },
      capped: {
        spend: () => openRouterKeyUsage(p.master_key!, minted.hash),
        release: () => openRouterDeleteKey(p.master_key!, minted.hash),
      },
      budget: 'capped',
    };
  }
  const key = needKey(p);
  if (p.kind === 'anthropic') return { env: { ANTHROPIC_API_KEY: key }, budget: 'counted' };
  const claude = ENDPOINTS[p.kind]?.claude;
  if (claude) return { env: { ANTHROPIC_BASE_URL: p.url ?? claude, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' }, budget: 'counted' };
  // Chat Completions only (Berget): Claude Code talks to the core's bridge with its job token; the key stays in the core.
  if (ENDPOINTS[p.kind] && o.bridge)
    return { env: { ANTHROPIC_BASE_URL: `${o.bridge.apiUrl}/bridge/${p.id}`, ANTHROPIC_AUTH_TOKEN: o.bridge.token, ANTHROPIC_API_KEY: '' }, budget: 'counted' };
  throw new Error(`provider ${p.id} (${p.kind}) cannot run jobs yet`);
}

// ---------- prices, for counting a job's cost while it runs ----------

/** Euros to dollars for Berget's prices: rough, which is enough to stop a job near its budget. */
const EUR_TO_USD = 1.1;
let catalog: { at: number; prices: Map<string, ModelPrice> } | null = null;

/** OpenRouter's public model list (no key needed) has per-token prices for most models, Claude's included. */
async function openRouterCatalog(): Promise<Map<string, ModelPrice>> {
  if (catalog && Date.now() - catalog.at < 6 * 3600_000) return catalog.prices;
  const prices = new Map<string, ModelPrice>();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { data?: Array<{ id: string; pricing?: Record<string, string> }> };
    for (const m of j.data ?? []) {
      const p = m.pricing;
      // Variants (:batch, :free…) share the base name once normalized; their prices are not the ones jobs pay.
      if (m.id.includes(':') || !p?.prompt || !p.completion) continue;
      const input = Number(p.prompt);
      prices.set(normalize(m.id), {
        input,
        output: Number(p.completion),
        cache_read: p.input_cache_read ? Number(p.input_cache_read) : input,
        cache_write: p.input_cache_write ? Number(p.input_cache_write) : input,
      });
    }
  } catch {
    /* no estimate; the harness's own total still arrives at the end */
  }
  catalog = { at: Date.now(), prices };
  return prices;
}

/** One spelling for the same model across providers: no provider prefix, lower case, dots as dashes, no date suffix. */
const normalize = (id: string) =>
  id
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replace(/\./g, '-')
    .replace(/:.*$/, '')
    .replace(/-\d{8}$/, '');

type BergetModel = { id: string; pricing?: { input?: number; output?: number; currency?: string } };
/** Berget's model list with prices, fetched at most every six hours (prices are asked for on every usage event). */
let bergetList: { at: number; data: BergetModel[] } | null = null;

/** Per-token prices for a model on this provider, or null when nobody says. */
export async function priceFor(s: Settings, p: ProviderConfig, model: string): Promise<ModelPrice | null> {
  // LiteLLM knows prices for the models it is configured with; for the rest, OpenRouter's list (Codex reports only
  // tokens, so without a price a job would count as free and its budget never stop it).
  if (p.kind === 'litellm') return (await modelPrice(p, model)) ?? (await openRouterCatalog()).get(normalize(model)) ?? null;
  if (p.kind === 'berget') {
    try {
      if (!bergetList || Date.now() - bergetList.at > 6 * 3600_000) {
        const res = await fetch(ENDPOINTS.berget!.models, { signal: AbortSignal.timeout(15_000) });
        bergetList = { at: Date.now(), data: ((await res.json()) as { data?: BergetModel[] }).data ?? [] };
      }
      const m = bergetList.data.find((x) => x.id === model)?.pricing;
      if (m?.input == null || m.output == null) return null;
      const rate = (m.currency === 'EUR' ? EUR_TO_USD : 1) / 1e6;
      return { input: m.input * rate, output: m.output * rate, cache_read: m.input * rate, cache_write: m.input * rate };
    } catch {
      return null;
    }
  }
  return (await openRouterCatalog()).get(normalize(model)) ?? null;
}

// ---------- OpenRouter's management API: keys per job ----------

const OR_KEYS = 'https://openrouter.ai/api/v1/keys';

async function openRouterKey(management: string, o: { name: string; limit: number }): Promise<{ key: string; hash: string }> {
  const res = await fetch(OR_KEYS, {
    method: 'POST',
    headers: { Authorization: `Bearer ${management}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: o.name, limit: Math.max(0.01, Number(o.limit.toFixed(4))) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenRouter could not create a key for this job: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { key: string; data: { hash: string } };
  return { key: j.key, hash: j.data.hash };
}

async function openRouterKeyUsage(management: string, hash: string): Promise<number> {
  const res = await fetch(`${OR_KEYS}/${hash}`, { headers: { Authorization: `Bearer ${management}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenRouter key usage: ${res.status}`);
  return Number(((await res.json()) as { data?: { usage?: number } }).data?.usage ?? 0);
}

/** A key left behind keeps what is left of its limit spendable: try twice, and say so when it stays. */
async function openRouterDeleteKey(management: string, hash: string): Promise<void> {
  let why = '';
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${OR_KEYS}/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${management}` }, signal: AbortSignal.timeout(20_000) });
      if (res.ok || res.status === 404) return;
      why = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (e) {
      why = (e as Error).message;
    }
  }
  throw new Error(`OpenRouter did not delete the key ${hash}: ${why}`);
}
