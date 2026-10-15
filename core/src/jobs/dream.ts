import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Ctx } from '../context.ts';
import type { Agent, Job } from '../store.ts';
import { briefingsDir } from './prompt.ts';

type Row = Record<string, unknown>;

/** Dream backups of agent.db kept per agent. */
const KEEP_BACKUPS = 14;

export function dreamSettings(ctx: Ctx) {
  const d = ctx.settings.dreaming ?? {};
  return {
    enabled: d.enabled !== false,
    cron: d.cron?.trim() || '0 3 * * *',
    model: d.model?.trim() || undefined,
    max_usd: d.max_usd ?? 0.5,
    max_minutes: d.max_minutes ?? 20,
  };
}

/** The model a dream uses: the configured one, else the agent's last (by convention its cheapest). */
export function dreamModel(ctx: Ctx, agent: Agent): string | undefined {
  return dreamSettings(ctx).model ?? agent.models.at(-1) ?? ctx.settings.defaults.models.at(-1);
}

/** Has the agent done anything since it last dreamt? Without new jobs there is nothing to dream about. */
export function hasNewWork(ctx: Ctx, agent: string, since: string): boolean {
  return !!ctx.db
    .prepare("SELECT 1 FROM jobs WHERE agent = ? AND trigger_type != 'dream' AND ended IS NOT NULL AND ended > ? LIMIT 1")
    .get(agent, since);
}

export function dreamSystemPrompt(agent: Agent): string {
  const base = readFileSync(join(briefingsDir(), 'dream.md'), 'utf8').replaceAll('{{agent}}', agent.name);
  return `${base}\n\n---\n\n# Your briefing (as it is now)\n\n${agent.briefing.trim() || '(empty)'}\n`;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The dream's user turn: what happened since the last dream, newest first. */
export function dreamPrompt(ctx: Ctx, agent: Agent, job: Job, since: string | null, tables: TableCount[] | null): string {
  const { db } = ctx;
  const from = since ?? '0000';
  const jobs = db
    .prepare(
      `SELECT id, trigger_type, trigger_detail, status, reason, cost_usd, ended, summary, recap FROM jobs
       WHERE agent = ? AND trigger_type != 'dream' AND ended IS NOT NULL AND ended > ? ORDER BY ended DESC LIMIT 60`,
    )
    .all(agent.name, from) as Row[];
  const total = Number(
    (db.prepare("SELECT COUNT(*) n FROM jobs WHERE agent = ? AND trigger_type != 'dream' AND ended > ?").get(agent.name, from) as Row).n,
  );
  const human = db
    .prepare(
      "SELECT id, title, body, created FROM messages WHERE to_addr = ? AND from_addr = 'human' AND created > ? ORDER BY created DESC LIMIT 30",
    )
    .all(`agent:${agent.name}`, from) as Row[];
  const last = db
    .prepare(
      "SELECT summary, ended FROM jobs WHERE agent = ? AND trigger_type = 'dream' AND id != ? AND summary IS NOT NULL ORDER BY ended DESC LIMIT 1",
    )
    .get(agent.name, job.id) as Row | undefined;

  const parts = [`# Dream ${job.id}\nTime: ${new Date().toISOString()}. Last dream: ${since ?? 'never'}.`];
  if (last?.summary) parts.push(`## What your last dream did (${last.ended as string})\n${clip(last.summary, 1500)}`);
  parts.push(
    `## Your jobs since then (${total}${total > jobs.length ? `, the newest ${jobs.length} shown` : ''})\n` +
      (jobs.length
        ? jobs
            .map((j) =>
              [
                `### ${j.id as string} · ${j.trigger_type as string}${j.trigger_detail ? ` (${clip(j.trigger_detail, 120)})` : ''} · ${j.status as string}${j.reason ? `: ${clip(j.reason, 200)}` : ''} · $${Number(j.cost_usd).toFixed(2)} · ended ${j.ended as string}`,
                j.summary ? `Summary: ${clip(j.summary, 800)}` : '',
                j.recap ? `Recap: ${clip(j.recap, 600)}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n')
        : 'None.'),
  );
  if (human.length)
    parts.push(
      `## What the human wrote to you since then\n${human.map((m) => `- ${m.created as string} (${m.id as string}): ${clip(m.title, 120)}${m.body ? ` — ${clip(m.body, 500)}` : ''}`).join('\n')}`,
    );
  if (tables)
    parts.push(
      `## Your database\n${tables.length ? tables.map((t) => `- \`${t.name}\`: ${t.rows ?? '?'} rows`).join('\n') : 'agent.db has no tables.'}`,
    );
  else parts.push('## Your database\nYou have no `agent.db` yet.');
  parts.push('Dream as your briefing describes, then end with `yaho finish --summary "..."`.');
  return parts.join('\n\n');
}

export interface TableCount {
  name: string;
  rows: number | null;
}

export function tableCounts(file: string): TableCount[] | null {
  if (!existsSync(file)) return null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]
      ).map((r) => r.name as string);
      return names.map((name) => {
        try {
          return { name, rows: Number((db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`).get() as Row).n) };
        } catch {
          return { name, rows: null };
        }
      });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function backupDir(ctx: Ctx, agent: string): string {
  return join(ctx.paths.root, 'dreams', agent);
}

export function backupFile(ctx: Ctx, agent: string, job: string): string {
  return join(backupDir(ctx, agent), `${job}.db`);
}

/** A consistent copy of agent.db before a dream (VACUUM INTO works while others have it open). Keeps the last few. */
export function backupAgentDb(ctx: Ctx, agent: string, job: string): boolean {
  const src = join(ctx.paths.agent(agent), 'agent.db');
  if (!existsSync(src)) return false;
  const dir = backupDir(ctx, agent);
  mkdirSync(dir, { recursive: true });
  const dest = backupFile(ctx, agent, job);
  rmSync(dest, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
  const old = readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return true;
}

/** Put agent.db back as it was before a dream. */
export function restoreAgentDb(ctx: Ctx, agent: string, job: string): boolean {
  const src = backupFile(ctx, agent, job);
  if (!existsSync(src)) return false;
  const dest = join(ctx.paths.agent(agent), 'agent.db');
  for (const f of [`${dest}-wal`, `${dest}-shm`, `${dest}-journal`]) rmSync(f, { force: true });
  copyFileSync(src, dest);
  return true;
}
