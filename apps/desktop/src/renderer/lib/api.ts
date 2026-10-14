import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from './platform.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** For use inside the app only (img, video, EventSource): it carries the token. Never open it in a browser. */
export const url = (path: string, params: Record<string, string> = {}) => {
  const u = new URL(path, platform.apiUrl);
  if (platform.token) u.searchParams.set('token', platform.token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

const auth = (): Record<string, string> => (platform.token ? { Authorization: `Bearer ${platform.token}` } : {});

/**
 * A link to an API file for the system browser. It carries a ticket that opens only this path, for a few minutes,
 * instead of the token, which must never leave the app.
 */
export async function externalUrl(path: string): Promise<string> {
  const u = new URL(path, platform.apiUrl);
  if (u.search) throw new Error('A ticket covers a path only, not a query.');
  const { ticket } = await api<{ ticket: string }>('/api/ticket', { body: { path: u.pathname } });
  u.searchParams.set('ticket', ticket);
  return u.toString();
}

/** Open an API file in the system browser (web: a new tab, opened at once so the popup blocker lets it through). */
export async function openExternalFile(path: string): Promise<void> {
  if (platform.kind === 'desktop') return platform.openExternal(await externalUrl(path));
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const link = await externalUrl(path);
    if (tab) tab.location.href = link;
    else platform.openExternal(link);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Save an API file as a download, fetched with the token in a header rather than in a link. */
export async function downloadFile(path: string, params: Record<string, string>, name: string): Promise<void> {
  const u = new URL(path, platform.apiUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: auth() });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  const link = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = link;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(link), 60_000);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit } = {}): Promise<T> {
  const res = await fetch(new URL(path, platform.apiUrl), {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
    headers: {
      ...auth(),
      ...(init.raw !== undefined ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }),
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

// ---------- live events ----------

export type LiveEvent =
  | { type: 'job'; job: Job }
  | { type: 'job_event'; job: string; event: JobEvent }
  | { type: 'message'; message: Message }
  | { type: 'changed'; entity: string; name?: string }
  | { type: 'notify'; title: string; body: string; message?: string }
  | { type: 'connection'; connected: boolean };

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function connect() {
  source = new EventSource(url('/api/events'));
  source.onopen = () => listeners.forEach((l) => l({ type: 'connection', connected: true }));
  source.onmessage = (m) => {
    const e = JSON.parse(m.data) as LiveEvent;
    listeners.forEach((l) => l(e));
  };
  source.onerror = () => {
    listeners.forEach((l) => l({ type: 'connection', connected: false }));
    // EventSource retries a dropped connection itself, but gives up for good after an error response (a proxy's 502
    // while the core restarts). Then start a new one.
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      setTimeout(() => {
        if (!source && listeners.size) connect();
      }, 2000);
    }
  };
}

export function onLive(l: Listener): () => void {
  if (!source) connect();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Fetch `path`, and refetch whenever a live event matches `refresh`. */
export function useApi<T>(path: string | null, refresh: (e: LiveEvent) => boolean = () => false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
    if (!path) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onLive((e) => {
      if ((e.type === 'connection' && e.connected) || refreshRef.current(e)) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 120);
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [path, load]);
  return { data, error, reload: load, setData };
}

// ---------- shapes ----------

export type WebhookVerify = 'none' | 'github' | 'stripe' | 'svix' | 'yaho';
export interface WebhookTrigger {
  webhook: string;
  verify?: WebhookVerify;
  instructions?: string;
  limit?: number;
  paused?: boolean;
}
export type TriggerSpec = { cron: string } | { inbox: true } | WebhookTrigger;

/** A webhook as the human sees it: with its URL path and signing secret. */
export interface Webhook {
  id: string;
  agent: string;
  name: string;
  path: string;
  verify: WebhookVerify;
  secret: string;
  instructions: string;
  limit: number;
  paused: boolean;
  last_delivery: string | null;
  last_rejected: string | null;
  deliveries_24h: number;
}

export interface Agent {
  name: string;
  enabled: boolean;
  briefing: string;
  harness: string;
  models: string[];
  budget_usd: number;
  max_parallel: number;
  email?: boolean;
  sms?: boolean;
  browser?: boolean;
  guardrails: {
    rate_per_hour?: number;
    cooldown_seconds?: number;
    hop_limit?: number;
    wait_for_inbox?: boolean;
    command_rules?: Array<{ pattern: string; action: 'block' | 'ask' | 'allow'; note?: string }>;
  };
  triggers: TriggerSpec[];
  projects: string[];
  resources: string[];
  /** Sidebar folder; null at the top level. */
  folder?: string | null;
  spent_usd?: number;
  running?: number;
  queued?: number;
  unread?: number;
  upcoming?: Array<{ type: string; at: string; cron?: string }>;
}

export interface Job {
  id: string;
  agent: string;
  session_id: string | null;
  trigger_type: string;
  trigger_detail: string | null;
  status: 'queued' | 'running' | 'finished' | 'sleeping' | 'failed' | 'budget_exhausted' | 'stopped';
  reason: string | null;
  model: string | null;
  cost_usd: number;
  /** Messages this job sent (in job lists). */
  messages?: number;
  resume_at: string | null;
  created: string;
  started: string | null;
  ended: string | null;
}

export interface JobEvent {
  id: number;
  kind: string;
  data: Record<string, unknown>;
  created: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: 'question' | 'instruction' | 'info' | 'reply';
  title: string;
  body: string;
  choices?: string[];
  steps?: Array<{ open?: string; copy?: string }>;
  /** The agent waits for an answer: the card offers Done (or the choices). */
  expects_response?: boolean;
  artifacts?: string[];
  reply_to: string | null;
  read: boolean;
  job: string | null;
  created: string;
}

export interface Project {
  name: string;
  title: string;
  briefing: string;
  agents: string[];
}

export interface Resource {
  name: string;
  briefing: string;
  keys: Array<{ name: string; secret: boolean; has_value?: boolean }>;
  agents: string[];
  kind?: 'keys' | 'composio';
  config?: { toolkit?: string; toolkit_name?: string; logo?: string; connected_account_id?: string };
}

export interface Artifact {
  id: string;
  project: string;
  agent: string;
  job: string | null;
  kind: string;
  file_path: string;
  created: string;
}

export interface FileEntry {
  path: string;
  size: number;
  modified: string;
  dir: boolean;
}
