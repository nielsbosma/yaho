import type { Ctx } from './context.ts';
import { chatRound, priceFor } from './providerApi.ts';
import { resolveModel } from './providers.ts';
import { addJobEvent, getAgent, getJob, HttpError, updateJob, type Job } from './store.ts';

type Row = Record<string, unknown>;

/** What the agent said during a job, oldest first. */
function texts(ctx: Ctx, job: string): string[] {
  return (ctx.db.prepare("SELECT data FROM job_events WHERE job = ? AND kind = 'text' ORDER BY id").all(job) as Row[])
    .map((r) => (JSON.parse(r.data as string) as { text?: string }).text ?? '')
    .filter((t) => t.trim());
}

/** Messages the agent sent during a job (inbox, email, SMS). */
function sent(ctx: Ctx, job: string): string[] {
  return (ctx.db.prepare('SELECT to_addr, title, body FROM messages WHERE job = ? ORDER BY created').all(job) as Row[]).map(
    (m) => `To ${m.to_addr}: ${m.title}\n${m.body}`,
  );
}

const trigger = (j: Job) => [j.trigger_type, j.trigger_detail].filter(Boolean).join(': ');

/** Put an ended job into the search index, replacing what was there. */
export function indexJob(ctx: Ctx, id: string, summary?: string | null): void {
  const j = getJob(ctx, id);
  const messages = [...texts(ctx, id), ...sent(ctx, id)].join('\n\n').slice(-200_000);
  ctx.db.prepare('DELETE FROM job_search WHERE job = ?').run(id);
  ctx.db
    .prepare('INSERT INTO job_search (job, agent, trigger, messages, summary, recap) VALUES (?,?,?,?,?,?)')
    .run(id, j.agent, trigger(j), messages, summary ?? j.summary ?? '', j.recap ?? '');
}

/**
 * Index ended jobs that are not in the index yet (those from before it existed). Jobs from then have no summary of
 * their own: the last job of a session gets the session's.
 */
export function indexMissing(ctx: Ctx): number {
  const rows = ctx.db
    .prepare(
      `SELECT j.id, CASE WHEN j.summary IS NULL AND j.ended = (SELECT MAX(ended) FROM jobs WHERE session_id = j.session_id)
              THEN s.summary END AS session_summary
       FROM jobs j LEFT JOIN sessions s ON s.id = j.session_id
       WHERE j.ended IS NOT NULL AND j.id NOT IN (SELECT job FROM job_search)`,
    )
    .all() as Row[];
  ctx.db.exec('BEGIN');
  try {
    for (const r of rows) indexJob(ctx, r.id as string, (r.session_summary as string) ?? undefined);
    ctx.db.exec('COMMIT');
  } catch (e) {
    ctx.db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

const RECAP_PROMPT = `You write the recap of one job an AI agent ran, so the agent can find it again later by searching.
In two or three plain sentences: what started the job or what was asked, what the agent did, and how it ended.
Keep the names, IDs, numbers, file names and URLs that someone might search for. No preamble, no Markdown.`;

/** A short recap of an ended job by the agent's background model, charged to the job. Indexes the job again. */
export async function writeRecap(ctx: Ctx, id: string): Promise<void> {
  if (ctx.settings.history?.recaps === false) return;
  const j = getJob(ctx, id);
  const said = texts(ctx, id).join('\n\n');
  if (!said.trim() && !j.summary) return;
  const agent = getAgent(ctx, j.agent);
  const name = agent.models.at(-1) ?? ctx.settings.defaults.models.at(-1);
  if (!name) return;
  const { provider, model } = resolveModel(ctx.settings, name);
  const body = said.length > 12_000 ? `${said.slice(0, 4000)}\n[…]\n${said.slice(-8000)}` : said;
  const input = [
    `Started by: ${trigger(j)}`,
    `Ended: ${j.status}${j.reason ? ` (${j.reason})` : ''}`,
    j.summary ? `The agent's own summary: ${j.summary}` : '',
    `What the agent said:\n${body}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const reply = await chatRound(provider, {
    model,
    messages: [
      { role: 'system', content: RECAP_PROMPT },
      { role: 'user', content: input },
    ],
    tools: [],
    max_tokens: 400,
  });
  const recap = typeof reply.message.content === 'string' ? reply.message.content.trim() : '';
  if (!recap) return;
  const price = reply.usage ? await priceFor(ctx.settings, provider, model).catch(() => null) : null;
  const cost = price && reply.usage ? reply.usage.input * price.input + reply.usage.output * price.output : 0;
  const now = getJob(ctx, id);
  updateJob(ctx, id, { recap: recap.slice(0, 2000), ...(cost ? { cost_usd: now.cost_usd + cost } : {}) });
  if (cost) addJobEvent(ctx, id, 'cost', { total_usd: now.cost_usd + cost, recap_usd: cost });
  indexJob(ctx, id);
}

/** Words as an FTS5 query: each one quoted, so nothing the agent types is FTS syntax. */
function ftsQuery(q: string, op: 'AND' | 'OR'): string {
  return (q.match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => `"${w}"`).join(` ${op} `);
}

export interface Hit {
  job: string;
  session: string | null;
  date: string;
  trigger: string;
  status: string;
  recap: string;
  snippet: string;
}

/** An agent's own past jobs that match, best first: every word if any job has them all, else any word. */
export function searchHistory(ctx: Ctx, agent: string, q: string, o: { since?: string; limit?: number } = {}): Hit[] {
  const limit = Math.min(Math.max(o.limit ?? 10, 1), 50);
  const run = (op: 'AND' | 'OR') => {
    const match = ftsQuery(q, op);
    if (!match) throw new HttpError(400, 'search for some words, e.g. yaho history search "invoice acme"');
    return ctx.db
      .prepare(
        `SELECT s.job, j.session_id, j.created, j.trigger_type, j.status, j.recap, j.summary,
                snippet(job_search, -1, '«', '»', '…', 16) AS snippet
         FROM job_search s JOIN jobs j ON j.id = s.job
         WHERE job_search MATCH ? AND s.agent = ? AND j.created >= ?
         ORDER BY bm25(job_search, 0, 0, 1, 1, 3, 3) LIMIT ?`,
      )
      .all(match, agent, o.since ?? '', limit) as Row[];
  };
  let rows = run('AND');
  if (!rows.length) rows = run('OR');
  return rows.map((r) => ({
    job: r.job as string,
    session: (r.session_id as string) ?? null,
    date: r.created as string,
    trigger: r.trigger_type as string,
    status: r.status as string,
    recap: ((r.recap as string) || (r.summary as string) || '').slice(0, 600),
    snippet: r.snippet as string,
  }));
}

/** One of the agent's own past jobs: why it started, how it ended, and what the agent said. */
export function showHistory(ctx: Ctx, agent: string, id: string) {
  const j = getJob(ctx, id);
  if (j.agent !== agent) throw new HttpError(403, `job ${id} is not yours`);
  let said = texts(ctx, id);
  // The end of a long job says the most about how it went.
  let total = 0;
  said = said
    .reverse()
    .filter((t) => (total += t.length) <= 30_000)
    .reverse();
  return {
    job: j.id,
    session: j.session_id,
    created: j.created,
    ended: j.ended,
    trigger: j.trigger_type,
    trigger_detail: j.trigger_detail,
    status: j.status,
    reason: j.reason,
    summary: j.summary,
    recap: j.recap,
    sent: sent(ctx, id),
    messages: said,
  };
}
