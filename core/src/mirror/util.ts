import { timingSafeEqual } from 'node:crypto';

/** Timing-safe string comparison. */
export const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** An error's message, whatever was thrown (undefined included). */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const chains = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with the same key has settled, so a check-then-act on one key cannot interleave. */
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(() => fn());
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** An in-memory sliding window: at most limit hits per key within windowMs. */
export class RateLimit {
  private hits = new Map<string, number[]>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts a hit for key; false (and not counted) when the key is over its limit. */
  take(key: string, at = Date.now()): boolean {
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => t > at - this.windowMs)) this.hits.delete(k);
    const recent = (this.hits.get(key) ?? []).filter((t) => t > at - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    return true;
  }
}

/** A list setting given as an array or as one string, split at commas, semicolons and newlines (and spaces with words). */
export function listSetting(v: unknown, words = true): string[] {
  const items = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(words ? /[\s,;]+/ : /[,;\n]+/) : [];
  return items.map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/** Whether an email address is on an allowlist of addresses and domains (example.com or @example.com); empty allows all. */
export function emailAllowed(allow: unknown, addr: string): boolean {
  const list = listSetting(allow);
  if (!list.length) return true;
  const a = addr.toLowerCase();
  const domain = a.slice(a.lastIndexOf('@') + 1);
  return list.some((x) => (x.includes('@') && !x.startsWith('@') ? x === a : x.replace(/^@/, '') === domain));
}

/** Whether a phone number (E.164) is on an allowlist; empty allows all. */
export function phoneAllowed(allow: unknown, phone: string): boolean {
  const list = listSetting(allow, false).map((x) => x.replace(/[^\d+]/g, '').replace(/^00/, '+'));
  return !list.length || list.includes(phone);
}

/**
 * Cuts text into pieces of at most max characters at paragraph or line breaks; adjust can move a hard cut back (to keep
 * a tag or entity whole).
 */
export function splitText(text: string, max: number, adjust?: (text: string, at: number) => number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n\n', max);
    if (at < max / 2) at = rest.lastIndexOf('\n', max);
    if (at < max / 2) at = adjust ? adjust(rest, max) : max;
    if (at <= 0) at = max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
