import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * File IO in folders an agent can write to. The core runs with more rights than the agent (on the server it can read
 * the API token and the database), so a symlink planted in a workspace must never send a core read or write elsewhere.
 */

export class UnsafePathError extends Error {}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Join rel under root as text, refusing `..` and absolute paths that leave it. */
export function joinUnder(root: string, rel: string): string {
  const full = normalize(isAbsolute(rel) ? rel : join(root, rel));
  if (!inside(normalize(root), full)) throw new UnsafePathError('bad path');
  return full;
}

/** The real path of the nearest existing ancestor of p (p itself when it exists). */
function realExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), relative(cur, p));
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      cur = up;
    }
  }
}

/** Throw unless p, followed through every symlink, still lies under root. */
export function assertUnder(root: string, p: string): void {
  const realRoot = existsSync(root) ? realpathSync(root) : normalize(root);
  if (!inside(realRoot, realExisting(p))) throw new UnsafePathError('bad path');
}

/** joinUnder plus assertUnder: a path under root that symlinks cannot redirect. */
export function resolveUnder(root: string, rel: string): string {
  const full = joinUnder(root, rel);
  assertUnder(root, full);
  return full;
}

/** True when p exists and is a symlink. */
export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Write a file under root without following a symlink at the file itself or anywhere between root and it. Creates
 * missing folders. `append` adds to an existing file.
 */
export function writeFileUnder(root: string, p: string, data: string | Uint8Array, opts: { append?: boolean; mode?: number } = {}): void {
  const full = joinUnder(root, p);
  assertUnder(root, dirname(full));
  mkdirSync(dirname(full), { recursive: true });
  assertUnder(root, dirname(full));
  if (isLink(full)) throw new UnsafePathError('refusing to write through a symlink');
  const flags = constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | (opts.append ? constants.O_APPEND : constants.O_TRUNC);
  const fd = openSync(full, flags, opts.mode ?? 0o666);
  try {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

