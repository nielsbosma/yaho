import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { resolveUnder, UnsafePathError, writeFileUnder } from './fsSafe.ts';

describe('fsSafe', () => {
  const base = mkdtempSync(join(tmpdir(), 'yaho-fs-'));
  const root = join(base, 'root');
  const secret = join(base, 'secret');
  writeFileSync(secret, 'token');
  writeFileUnder(root, 'a/b.txt', 'hi');

  it('allows plain paths and refuses ..', () => {
    expect(readFileSync(resolveUnder(root, 'a/b.txt'), 'utf8')).toBe('hi');
    expect(() => resolveUnder(root, '../secret')).toThrow(UnsafePathError);
  });

  it('refuses symlinks that leave the root, for reads and writes', () => {
    symlinkSync(secret, join(root, 'link'));
    symlinkSync(base, join(root, 'dir'));
    expect(() => resolveUnder(root, 'link')).toThrow(UnsafePathError);
    expect(() => resolveUnder(root, 'dir/secret')).toThrow(UnsafePathError);
    expect(() => writeFileUnder(root, 'link', 'x')).toThrow();
    expect(() => writeFileUnder(root, 'dir/new', 'x')).toThrow(UnsafePathError);
    expect(readFileSync(secret, 'utf8')).toBe('token');
  });

  it('refuses a dangling symlink', () => {
    symlinkSync(join(base, 'nope'), join(root, 'dangling'));
    expect(() => writeFileUnder(root, 'dangling', 'x')).toThrow();
  });
});
