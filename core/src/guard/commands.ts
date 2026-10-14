import type { Settings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { newId, now } from '../db/index.ts';
import type { Agent, Message } from '../store.ts';
import { addJobEvent, getAgent, getJob, markRead, saveAgent, sendMessage } from '../store.ts';
import { type CommandRule, DEFAULT_COMMAND_RULES, decide, exactRule } from './commandRules.ts';

type Row = Record<string, unknown>;

export const commandRulesOn = (s: Settings): boolean => !!s.command_rules?.enabled;

/** The agent's own rules first, then the global list (the defaults until the human edits it). */
export const rulesFor = (s: Settings, agent: Agent): CommandRule[] => [
  ...(agent.guardrails.command_rules ?? []),
  ...(s.command_rules?.rules ?? DEFAULT_COMMAND_RULES),
];

export const APPROVAL_CHOICES = ['Allow once', 'Always allow', 'Deny'];

const normal = (c: string) => c.trim().replace(/\s+/g, ' ');
const why = (r?: CommandRule) => (r?.note ? ` (${r.note})` : '');

/**
 * What the hook does with one shell command. block: refused, with the reason for the agent. ask: refused for now; the
 * human gets the question in the inbox and the job pauses until they answer, then resumes in the same session.
 */
export function checkCommand(
  ctx: Ctx,
  who: { agent: string; job: string },
  command: string,
): { decision: 'allow' | 'block'; reason?: string } {
  if (!commandRulesOn(ctx.settings) || !command.trim()) return { decision: 'allow' };
  const paused = 'Your job is paused now and resumes in this session once they answer. Stop here: do not run anything else.';
  if (ctx.db.prepare("SELECT 1 FROM command_approvals WHERE job = ? AND status = 'pending'").get(who.job))
    return { decision: 'block', reason: `A command is waiting for the human's approval. ${paused}` };
  const agent = getAgent(ctx, who.agent);
  const d = decide(command, rulesFor(ctx.settings, agent));
  const cmd = normal(command);
  if (d.action === 'allow') return { decision: 'allow' };
  if (d.action === 'block') {
    addJobEvent(ctx, who.job, 'guard', { text: `Blocked by Command Rules${why(d.rule)}: ${cmd}` });
    return {
      decision: 'block',
      reason: `Command Rules blocked this command${why(d.rule)}. Do not try to get around the rule; do the work another way, or ask the human with yaho send.`,
    };
  }

  const { db } = ctx;
  const session = getJob(ctx, who.job).session_id;
  const prev = db
    .prepare('SELECT * FROM command_approvals WHERE agent = ? AND session IS ? AND command = ? ORDER BY created DESC LIMIT 1')
    .get(who.agent, session, cmd) as Row | undefined;
  if (prev?.status === 'approved' && !prev.used) {
    db.prepare('UPDATE command_approvals SET used = 1 WHERE id = ?').run(prev.id as string);
    addJobEvent(ctx, who.job, 'guard', { text: `Approved by the human: ${cmd}` });
    return { decision: 'allow' };
  }
  if (prev?.status === 'denied')
    return { decision: 'block', reason: 'The human denied this command. Do not run it or a variant of it; do the work another way.' };

  const id = newId('apv');
  const msg = sendMessage(ctx, {
    from: `agent:${who.agent}`,
    to: 'human',
    type: 'question',
    title: `${who.agent} wants to run a command`,
    body: `\`\`\`\n${command.trim()}\n\`\`\`\n\nCommand Rules hold this back until you approve it${why(d.rule)}. The job is paused until you answer.`,
    choices: APPROVAL_CHOICES,
    job: who.job,
  });
  db.prepare('INSERT INTO command_approvals (id, agent, job, session, command, message, created) VALUES (?,?,?,?,?,?,?)').run(
    id,
    who.agent,
    who.job,
    session,
    cmd,
    msg.id,
    now(),
  );
  addJobEvent(ctx, who.job, 'guard', { text: `Waiting for your approval${why(d.rule)}: ${cmd}` });
  // Paused right after the harness has the answer, so it records why.
  ctx.runner!.stop(who.job, 'sleeping', `waiting for your approval to run: ${cmd.slice(0, 200)}`, { grace: 3000 });
  return { decision: 'block', reason: `This command needs the human's approval${why(d.rule)}; the request is in their inbox. ${paused}` };
}

/**
 * The human's answer to an approval question. Resumes the paused session with the outcome; true when the message was
 * such an answer (and so is not an ordinary message for the agent's inbox).
 */
export function answerApproval(ctx: Ctx, m: Message): boolean {
  if (m.from !== 'human' || !m.reply_to) return false;
  const a = ctx.db.prepare('SELECT * FROM command_approvals WHERE message = ?').get(m.reply_to) as Row | undefined;
  if (!a) return false;
  const answer = m.body.trim().toLowerCase();
  const always = answer.startsWith('always');
  const ok = always || /^(allow|approve|yes|ok)\b/.test(answer);
  const agent = a.agent as string;
  const cmd = a.command as string;
  // Claim the answer first: marking it read fires this again.
  const claimed = ctx.db
    .prepare("UPDATE command_approvals SET status = ?, decided = ? WHERE id = ? AND status = 'pending'")
    .run(ok ? 'approved' : 'denied', now(), a.id as string);
  if (!m.read) markRead(ctx, m.id, true);
  if (!Number(claimed.changes)) return true;
  if (always) {
    const g = getAgent(ctx, agent).guardrails;
    saveAgent(ctx, { name: agent, guardrails: { ...g, command_rules: [...(g.command_rules ?? []), exactRule(cmd)] } }, { author: 'human' });
  }
  const note = ok || /^deny\b/.test(answer) ? '' : ` They said: ${m.body.trim()}`;
  const detail = ok
    ? `the human approved \`${cmd}\`${always ? ' for good' : ' (once)'}. Run it now, then carry on with your work.`
    : `the human denied \`${cmd}\`. Do not run it or a variant of it; do the work another way or finish.${note}`;
  ctx.runner!.enqueue(agent, 'approval', { sessionId: a.session as string | null, detail, force: true });
  return true;
}
