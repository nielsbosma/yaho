import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ctx } from './context.ts';
import { addJobEvent, HttpError, sendMessage } from './store.ts';

const run = promisify(execFile);

export const IDEAS_REPO = 'nielsbosma/yaho';
/** Ideas one agent may file per day, so a confused agent cannot flood the tracker. */
export const IDEAS_PER_DAY = 3;

export interface Idea {
  title: string;
  body: string;
}

export type IdeaResult =
  | { filed: string }
  | { duplicate: string }
  | { sent_to_human: string; reason: string };

type Gh = (args: string[]) => Promise<string>;
const gh: Gh = async (args) => (await run('gh', args, { timeout: 30_000, windowsHide: true })).stdout;

/**
 * File an agent's idea for Yaho itself as a GitHub issue. Skips it when an issue with the same title exists.
 * Without a working gh CLI, the idea goes to the human's inbox with a link that opens a prefilled issue.
 */
export async function fileIdea(ctx: Ctx, who: { agent: string; job: string }, idea: Idea, cli: Gh = gh): Promise<IdeaResult> {
  const cfg = ctx.settings.ideas ?? {};
  if (cfg.enabled === false) throw new HttpError(403, 'filing ideas for Yaho is turned off in Settings');
  const title = idea.title?.trim();
  const body = idea.body?.trim();
  if (!title || !body) throw new HttpError(400, 'an idea needs a title and a body');
  const repo = cfg.repo || IDEAS_REPO;

  const today = ctx.db
    .prepare(
      "SELECT COUNT(*) n FROM job_events e JOIN jobs j ON j.id = e.job WHERE e.kind = 'idea' AND j.agent = ? AND e.created >= ?",
    )
    .get(who.agent, new Date(Date.now() - 86_400_000).toISOString()) as { n: number };
  if (today.n >= IDEAS_PER_DAY) throw new HttpError(429, `you filed ${IDEAS_PER_DAY} ideas in the last day; keep the rest in memory/ for later`);

  const full = `${body}\n\n---\n_Suggested by the Yaho agent \`${who.agent}\` (job \`${who.job}\`)._`;
  const record = (result: IdeaResult) => {
    addJobEvent(ctx, who.job, 'idea', { title, ...result });
    return result;
  };

  try {
    const found = JSON.parse(
      await cli(['issue', 'list', '-R', repo, '--state', 'all', '--search', `${title} in:title`, '--json', 'title,url', '--limit', '10']),
    ) as Array<{ title: string; url: string }>;
    const same = found.find((i) => i.title.trim().toLowerCase() === title.toLowerCase());
    if (same) return record({ duplicate: same.url });
    const url = (await cli(['issue', 'create', '-R', repo, '--title', title, '--body', full])).trim().split('\n').at(-1)!;
    return record({ filed: url });
  } catch (e) {
    const reason = (e as Error).message.split('\n')[0]!.slice(0, 200);
    const link = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(full)}`;
    const m = sendMessage(ctx, {
      from: `agent:${who.agent}`,
      to: 'human',
      type: 'instruction',
      title: `Idea for Yaho: ${title}`,
      body: `${body}\n\nYaho could not file this on GitHub itself (${reason}). Open the link to file it, or discard this message.`,
      steps: [{ open: link }],
      job: who.job,
    });
    return record({ sent_to_human: m.id, reason });
  }
}
