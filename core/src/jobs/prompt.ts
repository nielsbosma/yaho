import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Ctx } from '../context.ts';
import type { Agent, Job } from '../store.ts';
import { getProject, getResource, listMessages } from '../store.ts';

function briefingsDir(): string {
  if (process.env.YAHO_BRIEFINGS_DIR) return process.env.YAHO_BRIEFINGS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '../../../briefings'), join(here, '../briefings'), join(here, 'briefings')])
    if (existsSync(join(c, 'base.md'))) return c;
  return join(here, '../../../briefings');
}

export function baseBriefing(agent: string): string {
  return readFileSync(join(briefingsDir(), 'base.md'), 'utf8').replaceAll('{{agent}}', agent);
}

/** System prompt: base briefing, then the agent's own briefing. */
export function systemPrompt(agent: Agent): string {
  return `${baseBriefing(agent.name)}\n\n---\n\n# Your briefing\n\n${agent.briefing.trim() || '(empty: ask the human what to do)'}\n`;
}

/** The user turn: why this job started, then context (projects, resources, inbox, session summary). */
export function contextPrompt(ctx: Ctx, agent: Agent, job: Job, sessionSummary: string | null, resumed: boolean): string {
  const parts: string[] = [];
  // A follow-up's detail is the human's message: it gets its own section below.
  const followup = job.trigger_type === 'followup';
  const detail = !followup && job.trigger_detail ? ` (${job.trigger_detail})` : '';
  parts.push(
    resumed
      ? `# Job ${job.id} (resumed)\nYou are resuming your previous conversation. Trigger: ${job.trigger_type}${detail}.`
      : `# Job ${job.id}\nTrigger: ${job.trigger_type}${detail}. Time: ${new Date().toISOString()}.`,
  );
  if (agent.projects.length) {
    parts.push('## Your projects');
    for (const name of agent.projects) {
      const p = getProject(ctx, name);
      const dir = join(ctx.paths.project(name), 'files');
      const files = existsSync(dir) ? readdirSync(dir) : [];
      parts.push(
        `### ${p.title} (\`${p.name}\`)\n${p.briefing.trim()}\n\nContext files (read them with yaho project files): ${files.length ? files.map((f) => `\`${f}\``).join(', ') : 'none'}`,
      );
    }
  }
  if (agent.resources.length) {
    parts.push('## Your resources\nKey values are in your environment variables. Never print the secret ones.');
    for (const name of agent.resources) {
      const r = getResource(ctx, name);
      parts.push(
        r.kind === 'composio'
          ? `### ${r.name} (Composio: ${r.config?.toolkit_name ?? r.config?.toolkit})\n${r.briefing.trim()}`
          : `### ${r.name}\n${r.briefing.trim()}\n\nKeys: ${r.keys.map((k) => `\`${k.name}\`${k.secret ? ' (secret)' : ''}`).join(', ') || 'none'}`,
      );
    }
  }
  const unread = listMessages(ctx, { to: `agent:${agent.name}`, unread: true, limit: 50 });
  parts.push(
    unread.length
      ? `## Unread inbox (${unread.length})\n${YAML.stringify(unread.map((m) => ({ id: m.id, from: m.from, type: m.type, title: m.title, reply_to: m.reply_to, created: m.created })))}\nRead each with \`yaho inbox read <id>\`.`
      : '## Inbox\nNo unread messages.',
  );
  if (sessionSummary && !resumed) parts.push(`## Where you left off last time\n${sessionSummary}`);
  if (followup)
    parts.push(
      `## Follow-up from the human\n${job.trigger_detail ?? ''}\n\nThey are chatting with you about your work in this session. Answer in your reply text (Markdown): it is shown to them directly, so do not also send it with \`yaho send\`. If they ask for changes, make them. Then end with \`yaho finish --summary "..."\`.`,
    );
  else parts.push('Do your work, then end with `yaho finish --summary "..."` or `yaho sleep <duration>`.');
  return parts.join('\n\n');
}
