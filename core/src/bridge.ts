import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProviderConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { forProvider, safeJson } from './providerApi.ts';
import { resolveModel } from './providers.ts';
import { agentExists, getAgent, HttpError } from './store.ts';

/**
 * Claude Code speaks Anthropic's Messages API; Berget and OpenAI (any provider with only Chat Completions) do not.
 * For those jobs the core serves /bridge/<provider>/v1/messages and translates both ways: the request to Chat
 * Completions, and the reply (streamed or not) back to Messages. A job reaches it with its own job token, so the
 * provider's key never leaves the core.
 */

type Block = Record<string, unknown> & { type: string };
interface AnthropicRequest {
  model: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Block[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

const BASES: Record<string, string> = { berget: 'https://api.berget.ai/v1', openai: 'https://api.openai.com/v1' };

/** Anthropic request to Chat Completions. */
export function toChatCompletions(req: AnthropicRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const system = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text ?? '').join('\n\n');
  if (system) messages.push({ role: 'system', content: system });
  const text = (c: unknown): string =>
    typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: Block) => (b.type === 'text' ? String(b.text ?? '') : '')).join('') : '';
  for (const m of req.messages) {
    const blocks: Block[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: String(b.id), type: 'function', function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text(blocks) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages (they must follow the assistant turn), the rest one user message.
    for (const b of blocks.filter((x) => x.type === 'tool_result'))
      messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: text(b.content) || (b.is_error ? 'error' : '') });
    const parts = blocks
      .filter((b) => b.type === 'text' || b.type === 'image')
      .map((b) => {
        if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') };
        const src = b.source as { type: string; media_type?: string; data?: string; url?: string };
        return { type: 'image_url', image_url: { url: src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : String(src.url) } };
      });
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts });
  }
  return {
    model: req.model,
    messages,
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema ?? { type: 'object' } } })) }
      : {}),
    ...(req.tool_choice?.type === 'tool' ? { tool_choice: { type: 'function', function: { name: req.tool_choice.name } } } : {}),
    ...(req.tool_choice?.type === 'any' ? { tool_choice: 'required' } : {}),
    ...(req.max_tokens ? { max_tokens: req.max_tokens } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
    ...(req.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

/** Tool call ids as Anthropic writes them (letters, digits, _ and -); some models send ids like Write:0. */
const toolId = (id: string) => (/^[A-Za-z0-9_-]+$/.test(id) ? id : `toolu_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`);

const stopReason =(r?: string | null) => (r === 'tool_calls' ? 'tool_use' : r === 'length' ? 'max_tokens' : 'end_turn');
const msgId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A non-streamed Chat Completions reply as a Messages reply. */
export function fromChatCompletion(model: string, j: { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }) {
  const c = j.choices?.[0];
  const content: Block[] = [];
  if (c?.message?.content) content.push({ type: 'text', text: c.message.content });
  for (const t of c?.message?.tool_calls ?? []) content.push({ type: 'tool_use', id: toolId(t.id), name: t.function.name, input: safeJson(t.function.arguments) });
  return {
    id: msgId(),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason(c?.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
  };
}


/** A streamed Chat Completions reply, re-emitted as Messages events. */
async function streamBack(model: string, upstream: Response, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`);
  send('message_start', { message: { id: msgId(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let index = -1;
  let open: 'text' | 'tool' | null = null;
  const tools = new Map<number, number>(); // OpenAI tool index -> our block index
  let finish: string | null = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const close = () => {
    if (open) send('content_block_stop', { index });
    open = null;
  };
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const chunk = safeJson(data) as {
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        if (open !== 'text') {
          close();
          index++;
          open = 'text';
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: choice.delta.content } });
      }
      for (const t of choice.delta?.tool_calls ?? []) {
        if (!tools.has(t.index)) {
          close();
          index++;
          open = 'tool';
          tools.set(t.index, index);
          send('content_block_start', { index, content_block: { type: 'tool_use', id: toolId(t.id ?? `toolu_${index}`), name: t.function?.name ?? '', input: {} } });
        }
        if (t.function?.arguments) send('content_block_delta', { index: tools.get(t.index)!, delta: { type: 'input_json_delta', partial_json: t.function.arguments } });
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  } catch (e) {
    // The provider dropped the stream, timed out, or Claude Code went away: end with an error Claude Code can retry.
    if (!res.writableEnded) {
      send('error', { error: { type: 'api_error', message: `stream broke: ${(e as Error).message}` } });
      res.end();
    }
    return;
  }
  close();
  send('message_delta', { delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage: { output_tokens: usage.output_tokens, input_tokens: usage.input_tokens } });
  send('message_stop', {});
  res.end();
}

/** Tokens for the harness checks in Settings, which run without a job: in memory only, for one provider and model. */
const checkTokens = new Map<string, { provider: string; models: string[]; expires: number }>();

export function checkToken(provider: string, models: string[], ttlMs = 5 * 60_000): { token: string; revoke(): void } {
  const token = randomBytes(24).toString('hex');
  checkTokens.set(token, { provider, models, expires: Date.now() + ttlMs });
  return { token, revoke: () => void checkTokens.delete(token) };
}

/** Model names as the harness may send them: without a context suffix like [1m], ignoring case. */
const modelKey = (m: string) => m.replace(/\[[^\]]*\]$/, '').trim().toLowerCase();

/**
 * The models a caller may use on this provider: a running job's token (the agent's models served by this provider),
 * or a check's. Null for anyone else; the human's API token is not accepted, as it must never reach a harness.
 */
function allowedModels(ctx: Ctx, req: IncomingMessage, providerId: string): string[] | null {
  const h = req.headers;
  const token = (h['x-api-key'] as string | undefined) ?? (h.authorization?.startsWith('Bearer ') ? h.authorization.slice(7) : undefined);
  if (!token) return null;
  const check = checkTokens.get(token);
  if (check) {
    if (check.expires < Date.now()) checkTokens.delete(token);
    else return check.provider === providerId ? check.models : null;
  }
  const row = ctx.db.prepare('SELECT agent, expires, provider FROM job_tokens WHERE token = ?').get(token) as
    | { agent: string; expires: string; provider: string | null }
    | undefined;
  if (!row || row.expires <= new Date().toISOString() || row.provider !== providerId || !agentExists(ctx, row.agent)) return null;
  const agent = getAgent(ctx, row.agent);
  const models = (agent.models.length ? agent.models : ctx.settings.defaults.models).map((m) => resolveModel(ctx.settings, m));
  return models.filter((x) => x.provider.id === providerId).map((x) => x.model);
}

/** Handle /bridge/<provider>/v1/messages (and count_tokens). Returns false when the path is not the bridge's. */
export async function handleBridge(ctx: Ctx, req: IncomingMessage, res: ServerResponse, path: string, body: () => Promise<Buffer>): Promise<boolean> {
  const m = /^\/bridge\/([^/]+)\/v1\/messages(\/count_tokens)?$/.exec(path);
  if (process.env.YAHO_DEBUG === '1') console.log(`[bridge] ${req.method} ${req.url}`);
  if (!m) return false;
  const allowed = allowedModels(ctx, req, m[1]!);
  if (!allowed) throw new HttpError(401, 'the bridge is for running jobs only');
  const provider = ctx.settings.providers.find((p: ProviderConfig) => p.id === m[1]);
  const base = provider && (provider.url?.replace(/\/$/, '') ?? BASES[provider.kind]);
  if (!provider || !base) throw new HttpError(404, `no provider ${m[1]} to bridge`);
  let request: AnthropicRequest;
  try {
    request = JSON.parse((await body()).toString('utf8') || '{}') as AnthropicRequest;
  } catch {
    throw new HttpError(400, 'the request is not JSON');
  }
  if (m[2]) {
    // Claude Code asks for a token count now and then; a rough one is enough.
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: Math.ceil(JSON.stringify(request.messages ?? []).length / 4) }));
    return true;
  }
  // Budgets and Guard Rails are per model: only the agent's own models.
  if (!allowed.map(modelKey).includes(modelKey(String(request.model ?? ''))))
    throw new HttpError(403, `${request.model} is not one of this agent's models (${allowed.join(', ') || 'none on this provider'})`);
  // Stop the provider's work when Claude Code goes away, and never wait forever on it.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const upstream = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.any([gone.signal, AbortSignal.timeout(15 * 60_000)]),
    headers: { Authorization: `Bearer ${provider.api_key ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(forProvider(provider.kind, toChatCompletions(request) as { max_tokens?: number })),
  });
  if (!upstream.ok) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ type: 'error', error: { type: upstream.status === 429 ? 'rate_limit_error' : 'api_error', message: `${provider.id}: ${text.slice(0, 500)}` } }),
    );
    return true;
  }
  if (request.stream) await streamBack(request.model, upstream, res);
  else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fromChatCompletion(request.model, await upstream.json())));
  return true;
}
