import type { Settings } from '../config.ts';

/** LiteLLM admin calls. Used only when settings.litellm.master_key is set. */
async function admin<T>(s: Settings, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${s.litellm.url.replace(/\/$/, '')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${s.litellm.master_key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LiteLLM ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** One virtual key per job, capped at what the agent has left, so LiteLLM itself enforces the budget. */
export async function createLitellmKey(
  s: Settings,
  o: { maxBudget: number; models: string[]; agent: string; job: string },
): Promise<string> {
  const r = await admin<{ key: string }>(s, 'POST', '/key/generate', {
    max_budget: Math.max(0.0001, o.maxBudget),
    models: o.models,
    key_alias: `yaho-${o.agent}-${o.job}`,
    metadata: { yaho_agent: o.agent, yaho_job: o.job },
    duration: '7d',
  });
  return r.key;
}

export async function litellmKeySpend(s: Settings, key: string): Promise<number> {
  const r = await admin<{ info?: { spend?: number } }>(s, 'GET', `/key/info?key=${encodeURIComponent(key)}`);
  return Number(r.info?.spend ?? 0);
}

export async function deleteLitellmKey(s: Settings, key: string): Promise<void> {
  await admin(s, 'POST', '/key/delete', { keys: [key] });
}

export async function litellmModels(s: Settings): Promise<string[]> {
  const key = s.litellm.master_key ?? s.litellm.api_key;
  const res = await fetch(`${s.litellm.url.replace(/\/$/, '')}/v1/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`LiteLLM /v1/models: ${res.status}`);
  const j = (await res.json()) as { data?: Array<{ id: string }> };
  return (j.data ?? []).map((m) => m.id);
}
