import type { Ctx } from '../context.ts';
import { HttpError, getResource } from '../store.ts';

/**
 * Dopbase REST client. One Dopbase project per YAHO resource (`<prefix><resource>`), one environment
 * (settings.dopbase.environment). YAHO's own database stores only key names and flags.
 */
export class Dopbase {
  ctx: Ctx;
  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  get local() {
    return this.ctx.settings.dopbase.mode === 'bundled' ? this.ctx.localDopbase : undefined;
  }

  get url(): string {
    return (this.local?.url ?? this.ctx.settings.dopbase.url).replace(/\/$/, '');
  }

  get configured(): boolean {
    if (this.ctx.settings.dopbase.mode === 'bundled') return !!this.local?.child;
    return !!this.ctx.settings.dopbase.url && !!this.ctx.settings.dopbase.token;
  }

  private async token(fresh = false): Promise<string> {
    if (this.ctx.settings.dopbase.mode === 'bundled') {
      if (!this.local?.child)
        throw new HttpError(503, `the bundled Dopbase is not running${this.local?.lastError ? `: ${this.local.lastError}` : ''}`);
      return this.local.sessionToken(fresh);
    }
    const token = this.ctx.settings.dopbase.token;
    if (!token) throw new HttpError(503, 'Dopbase is not configured: set dopbase.token in Settings');
    return token;
  }

  async call<T>(method: string, path: string, body?: unknown, allow404 = false, retried = false): Promise<T | null> {
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token(retried)}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // A bundled session can expire; sign in again once.
    if (res.status === 401 && this.local && !retried) return this.call(method, path, body, allow404, true);
    if (allow404 && res.status === 404) return null;
    const text = await res.text();
    const env = text ? (JSON.parse(text) as { success?: boolean; data?: T; error?: Record<string, string> }) : {};
    if (!res.ok || env.success === false) {
      // Error codes only; Dopbase never echoes values, and neither do we.
      throw new HttpError(502, `Dopbase ${method} ${path}: ${res.status} ${Object.keys(env.error ?? {}).join(', ')}`);
    }
    return (env.data ?? null) as T | null;
  }

  projectName(resource: string): string {
    return `${this.ctx.settings.dopbase.project_prefix}${resource}`;
  }

  async health(): Promise<unknown> {
    const res = await fetch(`${this.url}/api/v1/health`);
    return res.json();
  }

  /** Environment id for a resource, creating the project and environment when `create` is set. */
  async environmentId(resource: string, create: boolean): Promise<string | null> {
    const project = this.projectName(resource);
    const envName = this.ctx.settings.dopbase.environment;
    const ref = encodeURIComponent(`${project}/${envName}`);
    const found = await this.call<{ id: string }>('GET', `/environments/resolve?reference=${ref}`, undefined, true).catch((e) => {
      if (create) return null;
      throw e;
    });
    if (found?.id) return found.id;
    if (!create) return null;
    await this.call('POST', '/projects', { name: project }).catch(() => undefined); // may already exist
    const env = await this.call<{ id: string }>('POST', `/projects/${encodeURIComponent(project)}/environments`, { name: envName }).catch(
      async () => this.call<{ id: string }>('GET', `/environments/resolve?reference=${ref}`),
    );
    return env?.id ?? null;
  }

  async setValue(resource: string, key: string, value: string): Promise<void> {
    const id = await this.environmentId(resource, true);
    await this.call('PUT', `/environments/${id}/secrets/${encodeURIComponent(key)}`, { value });
    this.ctx.db.prepare('UPDATE resource_keys SET has_value = 1 WHERE resource = ? AND name = ?').run(resource, key);
  }

  async deleteValue(resource: string, key: string): Promise<void> {
    const id = await this.environmentId(resource, false);
    if (id) await this.call('DELETE', `/environments/${id}/secrets/${encodeURIComponent(key)}`, undefined, true);
    this.ctx.db.prepare('UPDATE resource_keys SET has_value = 0 WHERE resource = ? AND name = ?').run(resource, key);
  }

  /** All values of a resource's declared keys, for injection into a harness environment. */
  async runtimeValues(resource: string): Promise<Record<string, string>> {
    const declared = new Set(getResource(this.ctx, resource).keys.map((k) => k.name));
    const id = await this.environmentId(resource, false);
    if (!id) return {};
    const data = await this.call<{ entries: Array<{ key: string; value: string }> }>('GET', `/environments/${id}/secrets/runtime`);
    const out: Record<string, string> = {};
    for (const e of data?.entries ?? []) if (declared.has(e.key)) out[e.key] = e.value;
    return out;
  }
}

/** Values for every resource an agent may use. Missing Dopbase config yields an empty env plus a reason. */
export async function envForAgent(ctx: Ctx, resources: string[]): Promise<{ env: Record<string, string>; warnings: string[] }> {
  const dop = new Dopbase(ctx);
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  if (!resources.some((r) => getResource(ctx, r).kind !== 'composio')) return { env, warnings };
  if (!dop.configured) return { env, warnings: ['Dopbase is not configured; no resource keys were injected'] };
  for (const r of resources) {
    // Composio resources have no values to inject: agents use them through yaho tool.
    if (getResource(ctx, r).kind === 'composio') continue;
    try {
      Object.assign(env, await dop.runtimeValues(r));
    } catch (e) {
      warnings.push(`resource ${r}: ${(e as Error).message}`);
    }
  }
  return { env, warnings };
}
