import type { ProviderConfig } from '../config.ts';

/** LiteLLM admin calls, to the given LiteLLM provider. Used only when it has a master key. */
async function admin<T>(p: ProviderConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${(p.url ?? '').replace(/\/$/, '')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${p.master_key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LiteLLM ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** One virtual key per job, capped at what the agent has left, so LiteLLM itself enforces the budget. */
export async function createLitellmKey(
  p: ProviderConfig,
  o: { maxBudget: number; models: string[]; agent: string; job: string },
): Promise<string> {
  const r = await admin<{ key: string }>(p, 'POST', '/key/generate', {
    max_budget: Math.max(0.0001, o.maxBudget),
    models: o.models,
    key_alias: `yaho-${o.agent}-${o.job}`,
    metadata: { yaho_agent: o.agent, yaho_job: o.job },
    duration: '7d',
  });
  return r.key;
}

export async function litellmKeySpend(p: ProviderConfig, key: string): Promise<number> {
  const r = await admin<{ info?: { spend?: number } }>(p, 'GET', `/key/info?key=${encodeURIComponent(key)}`);
  return Number(r.info?.spend ?? 0);
}

export async function deleteLitellmKey(p: ProviderConfig, key: string): Promise<void> {
  await admin(p, 'POST', '/key/delete', { keys: [key] });
}

export async function litellmModels(p: ProviderConfig): Promise<string[]> {
  const key = p.master_key ?? p.api_key;
  const res = await fetch(`${(p.url ?? '').replace(/\/$/, '')}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`LiteLLM /v1/models: ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ id: string }> };
  return (j.data ?? []).map((m) => m.id);
}

export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

const prices = new Map<string, { at: number; price: ModelPrice | null }>();

/** Per-token prices from LiteLLM's /model/info, cached for an hour. Null when the proxy does not say. */
export async function modelPrice(p: ProviderConfig, model: string): Promise<ModelPrice | null> {
  const hit = prices.get(`${p.id}|${model}`);
  if (hit && Date.now() - hit.at < 3600_000) return hit.price;
  let price: ModelPrice | null = null;
  try {
    const key = p.master_key ?? p.api_key;
    const res = await fetch(`${(p.url ?? '').replace(/\/$/, '')}/model/info`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { data?: Array<{ model_name: string; model_info?: Record<string, number | null> }> };
    const info = j.data?.find((m) => m.model_name === model)?.model_info;
    // LiteLLM says 0 for models it has no price for: that is unknown, not free.
    if (info?.input_cost_per_token && info.output_cost_per_token) {
      price = {
        input: info.input_cost_per_token,
        output: info.output_cost_per_token,
        cache_read: info.cache_read_input_token_cost ?? info.input_cost_per_token,
        cache_write: info.cache_creation_input_token_cost ?? info.input_cost_per_token,
      };
    }
  } catch {
    /* no estimate; the final total still arrives with the result */
  }
  prices.set(`${p.id}|${model}`, { at: Date.now(), price });
  return price;
}
