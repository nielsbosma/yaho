import type { ProviderConfig, Settings } from './config.ts';
import { createLitellmKey, litellmModels, modelPrice, type ModelPrice } from './jobs/litellm.ts';
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
};

const keyOf = (p: ProviderConfig) => p.master_key ?? p.api_key;
const needKey = (p: ProviderConfig) => {
  const k = keyOf(p);
  if (!k) throw new HttpError(503, `set the API key for ${p.id} in Settings first`);
  return k;
};
const chatBase = (p: ProviderConfig) => (p.kind === 'litellm' ? `${(p.url ?? '').replace(/\/$/, '')}/v1` : (p.url?.replace(/\/$/, '') ?? ENDPOINTS[p.kind]?.chat));

/** Model names this provider offers. */
export async function listModels(s: Settings, p: ProviderConfig): Promise<string[]> {
  if (p.kind === 'litellm') return litellmModels(s);
  const ep = ENDPOINTS[p.kind];
  if (!ep) throw new HttpError(400, `unknown provider kind ${p.kind}`);
  const key = needKey(p);
  const headers: Record<string, string> =
    p.kind === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` };
  const res = await fetch(ep.models, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(502, `${p.id}: listing models answered ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data?: Array<{ id: string; capabilities?: { function_calling?: boolean }; model_type?: string }> };
  let list = j.data ?? [];
  // Berget also serves speech, embeddings and rerankers; only chat models with tool calling can run agents.
  if (p.kind === 'berget') list = list.filter((m) => m.capabilities?.function_calling);
  return list.map((m) => m.id).sort();
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

export interface ChatReply {
  message: OAIMessage;
  /** stop, tool_calls, or length (cut off at the output limit). */
  finish_reason?: string;
}

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
    body: JSON.stringify({ ...body, messages: body.messages.map(clean) }),
  });
  if (!res.ok) throw new HttpError(502, `${p.id}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { choices: Array<{ message: OAIMessage; finish_reason?: string }> };
  return { message: j.choices[0]!.message, finish_reason: j.choices[0]!.finish_reason };
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
      const calls = (m.tool_calls ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.function.name, input: t.function.arguments ? JSON.parse(t.function.arguments) : {} }));
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
  });
  if (!res.ok) throw new HttpError(502, `Anthropic: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string };
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const tool_calls = j.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id!, type: 'function' as const, function: { name: b.name!, arguments: JSON.stringify(b.input ?? {}) } }));
  return {
    message: { role: 'assistant', content: text, ...(tool_calls.length ? { tool_calls } : {}) },
    finish_reason: j.stop_reason === 'max_tokens' ? 'length' : j.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
  };
}

// ---------- jobs: the environment Claude Code gets ----------

export interface JobAccess {
  /** ANTHROPIC_* variables for Claude Code. */
  env: Record<string, string>;
  /** A key minted for this job alone (LiteLLM with a master key): the provider caps its spend. */
  jobKey?: string;
  /** capped: the provider refuses past the budget. counted: Yaho adds up the reported cost and stops the job. */
  budget: 'capped' | 'counted';
}

/** How a job's Claude Code reaches this provider, with the agent's remaining budget. */
export async function jobAccess(s: Settings, p: ProviderConfig, o: { models: string[]; remaining: number; agent: string; job: string }): Promise<JobAccess> {
  if (p.kind === 'litellm') {
    if (p.master_key) {
      const jobKey = await createLitellmKey(s, { maxBudget: o.remaining, models: o.models, agent: o.agent, job: o.job });
      return { env: { ANTHROPIC_BASE_URL: p.url ?? '', ANTHROPIC_AUTH_TOKEN: jobKey }, jobKey, budget: 'capped' };
    }
    return { env: { ANTHROPIC_BASE_URL: p.url ?? '', ANTHROPIC_AUTH_TOKEN: p.api_key ?? '' }, budget: 'counted' };
  }
  const key = needKey(p);
  if (p.kind === 'anthropic') return { env: { ANTHROPIC_API_KEY: key }, budget: 'counted' };
  const claude = ENDPOINTS[p.kind]?.claude;
  if (claude) return { env: { ANTHROPIC_BASE_URL: p.url ?? claude, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' }, budget: 'counted' };
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
      if (!p?.prompt || !p.completion) continue;
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

/** One spelling for the same model across providers: no provider prefix, lower case, dots as dashes. */
const normalize = (id: string) => id.toLowerCase().replace(/^[^/]+\//, '').replace(/\./g, '-').replace(/:.*$/, '');

/** Per-token prices for a model on this provider, or null when nobody says. */
export async function priceFor(s: Settings, p: ProviderConfig, model: string): Promise<ModelPrice | null> {
  if (p.kind === 'litellm') return modelPrice(s, model);
  if (p.kind === 'berget') {
    try {
      const res = await fetch(ENDPOINTS.berget!.models, { signal: AbortSignal.timeout(15_000) });
      const j = (await res.json()) as { data?: Array<{ id: string; pricing?: { input?: number; output?: number; currency?: string } }> };
      const m = j.data?.find((x) => x.id === model)?.pricing;
      if (m?.input == null || m.output == null) return null;
      const rate = (m.currency === 'EUR' ? EUR_TO_USD : 1) / 1e6;
      return { input: m.input * rate, output: m.output * rate, cache_read: m.input * rate, cache_write: m.input * rate };
    } catch {
      return null;
    }
  }
  return (await openRouterCatalog()).get(normalize(model)) ?? null;
}
