import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { apiToken, loadSettings, paths } from '../config.ts';
import { openDb } from './index.ts';
import { migrations } from './migrations.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-test-'));
  process.env.YAHO_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('data directory', () => {
  it('creates settings, token and database on first start', () => {
    const p = paths();
    const settings = loadSettings();
    const token = apiToken();
    const db = openDb(p.db);
    expect(existsSync(p.settings)).toBe(true);
    expect(existsSync(p.token)).toBe(true);
    expect(existsSync(p.db)).toBe(true);
    expect(settings.server.port).toBe(4700);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(apiToken()).toBe(token);
    db.close();
  });

  it('migrates every table once, and a second open migrates nothing', () => {
    const file = join(dir, 'yaho.db');
    const db = openDb(file);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (t) => t.name,
    );
    for (const t of [
      'agents',
      'briefing_history',
      'triggers',
      'projects',
      'resources',
      'resource_keys',
      'agent_projects',
      'agent_resources',
      'sessions',
      'jobs',
      'job_events',
      'job_tokens',
      'messages',
      'artifacts',
    ])
      expect(tables).toContain(t);
    db.close();
    const again = openDb(file);
    expect((again.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(migrations.length);
    again.close();
  });
});
