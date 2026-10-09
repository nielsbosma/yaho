import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';

/**
 * Composio (https://composio.dev): hosted connections to hundreds of apps, with Composio-managed OAuth. YAHO keeps
 * one Composio API key in Settings; every call goes through the core, so agents never see that key.
 * API: v3.1, `x-api-key` header, cursor pagination ({ items, next_cursor }).
 */

export interface Toolkit {
  slug: string;
  name: string;
  logo: string;
  description: string;
  categories: string[];
  no_auth: boolean;
  managed_auth: boolean;
  tools_count: number;
}

export interface Connection {
  id: string;
  status: string;
  toolkit: string;
  user_id: string;
  alias?: string | null;
  created_at: string;
}

export interface Tool {
  slug: string;
  name: string;
  description: string;
  input_parameters: unknown;
  version?: string;
}

type Raw = Record<string, unknown>;

export class Composio {
  ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  get settings() {
    return this.ctx.settings.composio ?? {};
  }

  get configured(): boolean {
    return !!this.settings.api_key;
  }

  get userId(): string {
    return this.settings.user_id || 'yaho';
  }

  async call<T>(method: string, path: string, query: Record<string, string | string[] | undefined> = {}, body?: unknown): Promise<T> {
    if (!this.settings.api_key) throw new HttpError(503, 'add a Composio API key in Settings first');
    const base = (this.settings.url ?? 'https://backend.composio.dev/api/v3.1').replace(/\/$/, '');
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, item);
    }
    const res = await fetch(u, {
      method,
      headers: { 'x-api-key': this.settings.api_key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const msg =
        (data as { error?: { message?: string }; message?: string } | null)?.error?.message ??
        (data as { message?: string } | null)?.message;
      throw new HttpError(
        res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 502 : 400,
        `Composio: ${res.status} ${msg ?? String(text).slice(0, 200)}`,
      );
    }
    return data as T;
  }

  async toolkits(
    opts: { search?: string; category?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ items: Toolkit[]; next_cursor: string | null }> {
    const r = await this.call<{ items: Raw[]; next_cursor?: string | null }>('GET', '/toolkits', {
      search: opts.search,
      category: opts.category,
      cursor: opts.cursor,
      limit: String(opts.limit ?? 48),
      sort_by: 'usage',
    });
    return { items: r.items.map(toToolkit), next_cursor: r.next_cursor ?? null };
  }

  async toolkit(slug: string): Promise<Toolkit> {
    return toToolkit(await this.call<Raw>('GET', `/toolkits/${encodeURIComponent(slug)}`));
  }

  async connections(opts: { toolkit?: string } = {}): Promise<Connection[]> {
    const out: Connection[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ items: Raw[]; next_cursor?: string | null }>('GET', '/connected_accounts', {
        user_ids: [this.userId],
        toolkit_slugs: opts.toolkit ? [opts.toolkit] : undefined,
        order_by: 'created_at',
        order_direction: 'desc',
        limit: '100',
        cursor,
      });
      out.push(...r.items.map(toConnection));
      if (!r.next_cursor) break;
      cursor = r.next_cursor;
    }
    return out;
  }

  async connection(id: string): Promise<Connection> {
    return toConnection(await this.call<Raw>('GET', `/connected_accounts/${encodeURIComponent(id)}`));
  }

  /** Start connecting an app: reuse (or create) a Composio-managed auth config, then get a hosted sign-in link. */
  async connect(toolkit: string): Promise<{ id: string; redirect_url: string }> {
    const configs = await this.call<{ items: Raw[] }>('GET', '/auth_configs', {
      toolkit_slug: toolkit,
      is_composio_managed: 'true',
      limit: '10',
    });
    let authConfig = configs.items.find((c) => c.status !== 'DISABLED')?.id as string | undefined;
    if (!authConfig) {
      const created = await this.call<{ auth_config: { id: string } }>(
        'POST',
        '/auth_configs',
        {},
        {
          toolkit: { slug: toolkit },
          auth_config: { type: 'use_composio_managed_auth' },
        },
      );
      authConfig = created.auth_config.id;
    }
    const link = await this.call<{ redirect_url: string; connected_account_id: string }>(
      'POST',
      '/connected_accounts/link',
      {},
      {
        auth_config_id: authConfig,
        user_id: this.userId,
      },
    );
    return { id: link.connected_account_id, redirect_url: link.redirect_url };
  }

  async tools(toolkit: string, opts: { search?: string; limit?: number } = {}): Promise<Tool[]> {
    const r = await this.call<{ items: Raw[] }>('GET', '/tools', {
      toolkit_slug: toolkit,
      search: opts.search,
      limit: String(opts.limit ?? 100),
    });
    return r.items.map((t) => ({
      slug: String(t.slug),
      name: String(t.name ?? t.slug),
      description: String(t.description ?? ''),
      input_parameters: t.input_parameters ?? {},
      version: t.version ? String(t.version) : undefined,
    }));
  }

  async execute(
    tool: string,
    connectedAccountId: string,
    args: unknown,
  ): Promise<{ successful: boolean; data: unknown; error: string | null }> {
    const r = await this.call<{ successful: boolean; data: unknown; error: string | null }>(
      'POST',
      `/tools/execute/${encodeURIComponent(tool)}`,
      {},
      {
        connected_account_id: connectedAccountId,
        user_id: this.userId,
        arguments: args ?? {},
      },
    );
    return { successful: !!r.successful, data: r.data, error: r.error ?? null };
  }
}

function toToolkit(t: Raw): Toolkit {
  const meta = (t.meta ?? {}) as Raw;
  return {
    slug: String(t.slug),
    name: String(t.name ?? t.slug),
    logo: String(meta.logo ?? ''),
    description: String(meta.description ?? ''),
    categories: ((meta.categories as Array<{ name?: string }>) ?? []).map((c) => String(c.name ?? '')).filter(Boolean),
    no_auth: !!t.no_auth,
    managed_auth: Array.isArray(t.composio_managed_auth_schemes) && (t.composio_managed_auth_schemes as unknown[]).length > 0,
    tools_count: Number(meta.tools_count ?? 0),
  };
}

function toConnection(c: Raw): Connection {
  return {
    id: String(c.id),
    status: String(c.status ?? ''),
    toolkit: String((c.toolkit as Raw | undefined)?.slug ?? ''),
    user_id: String(c.user_id ?? ''),
    alias: (c.alias as string | null | undefined) ?? null,
    created_at: String(c.created_at ?? ''),
  };
}
