import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { saveSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';
import * as s from '../store.ts';

/**
 * The in-app assistant: a chat that can do anything the UI can, by calling the same store functions as tools.
 * Runs through the LiteLLM proxy (OpenAI-style tool calling). Secret values never pass through it.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface Step {
  tool: string;
  args: unknown;
  ok: boolean;
  result: unknown;
}

type ToolFn = (args: Record<string, unknown>, out: { navigate?: string[] }) => unknown | Promise<unknown>;
interface Tool {
  description: string;
  parameters: Record<string, unknown>;
  run: ToolFn;
}

const str = (d: string) => ({ type: 'string', description: d });
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required });

function tools(ctx: Ctx): Record<string, Tool> {
  const runner = () => {
    if (!ctx.runner) throw new HttpError(503, 'job runner not started');
    return ctx.runner;
  };
  const yamlDef = <T>(a: Record<string, unknown>): T => {
    if (typeof a.yaml !== 'string') throw new HttpError(400, 'yaml is required');
    const parsed = YAML.parse(a.yaml);
    if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'yaml must be a mapping');
    return parsed as T;
  };
  return {
    list_agents: {
      description: 'List all agents with status, spend, triggers, projects and resources.',
      parameters: obj({}),
      run: () => s.listAgents(ctx),
    },
    get_agent: {
      description: 'Get one agent, including its full briefing.',
      parameters: obj({ name: str('agent name') }, ['name']),
      run: (a) => s.getAgent(ctx, String(a.name)),
    },
    save_agent: {
      description:
        'Create or update an agent from a YAML definition (fields: name, enabled, briefing, harness, models, budget_usd, max_parallel, triggers [{cron: "..."} | {inbox: true}], projects, resources, guardrails {rate_per_hour, cooldown_seconds, hop_limit, wait_for_inbox: skip scheduled runs while the human has unread messages from the agent}). Omitted fields keep their current value. To rename, pass rename_from.',
      parameters: obj({ yaml: str('the agent definition in YAML'), rename_from: str('current name, when renaming') }, ['yaml']),
      run: (a, out) => {
        const def = yamlDef<s.Agent>(a);
        const agent = s.saveAgent(ctx, def, { rename: a.rename_from ? String(a.rename_from) : undefined });
        out.navigate = ['agents', agent.name];
        return agent;
      },
    },
    delete_agent: {
      description: 'Delete an agent. Destructive: only after the human has confirmed in this chat.',
      parameters: obj({ name: str('agent name'), confirmed: { type: 'boolean', description: 'true once the human said yes' } }, [
        'name',
        'confirmed',
      ]),
      run: (a) => {
        if (a.confirmed !== true) throw new HttpError(400, 'ask the human to confirm first');
        s.deleteAgent(ctx, String(a.name));
        return { deleted: a.name };
      },
    },
    run_agent: {
      description: 'Start a job for an agent now (Run Now).',
      parameters: obj({ name: str('agent name') }, ['name']),
      run: (a, out) => {
        const job = runner().enqueue(String(a.name), 'manual', { force: true }) as s.Job;
        out.navigate = ['jobs', job.id];
        return job;
      },
    },
    list_jobs: {
      description: 'List recent jobs, optionally for one agent or only active ones.',
      parameters: obj({ agent: str('agent name'), active: { type: 'boolean' } }),
      run: (a) => s.listJobs(ctx, { agent: a.agent ? String(a.agent) : undefined, active: a.active === true, limit: 30 }),
    },
    get_job: {
      description: 'Get a job and its last events (output, tool calls, results).',
      parameters: obj({ id: str('job id') }, ['id']),
      run: (a) => ({
        job: s.getJob(ctx, String(a.id)),
        events: s
          .jobEvents(ctx, String(a.id))
          .filter((e) => (e as { kind?: string }).kind !== 'prompt')
          .slice(-40),
      }),
    },
    stop_job: {
      description: 'Stop a running or queued job.',
      parameters: obj({ id: str('job id') }, ['id']),
      run: (a) => (runner().stop(String(a.id), 'stopped', 'stopped from the assistant'), { stopped: a.id }),
    },
    continue_job: {
      description: 'Continue a failed, stopped or budget-exhausted job in place (raise the budget first if it ran out).',
      parameters: obj({ id: str('job id') }, ['id']),
      run: (a) => (runner().continueJob(String(a.id)), { continued: a.id }),
    },
    list_projects: { description: 'List projects.', parameters: obj({}), run: () => s.listProjects(ctx) },
    save_project: {
      description: 'Create or update a project from YAML (name, title, briefing, agents).',
      parameters: obj({ yaml: str('the project in YAML'), rename_from: str('current name, when renaming') }, ['yaml']),
      run: (a, out) => {
        const p = s.saveProject(ctx, yamlDef<s.Project & { agents?: string[] }>(a), a.rename_from ? String(a.rename_from) : undefined);
        out.navigate = ['projects', p.name];
        return p;
      },
    },
    delete_project: {
      description: 'Delete a project with its files and artifacts. Destructive: only after the human confirmed.',
      parameters: obj({ name: str('project name'), confirmed: { type: 'boolean' } }, ['name', 'confirmed']),
      run: (a) => {
        if (a.confirmed !== true) throw new HttpError(400, 'ask the human to confirm first');
        s.deleteProject(ctx, String(a.name));
        return { deleted: a.name };
      },
    },
    list_resources: {
      description: 'List resources with their key names and whether each key has a value.',
      parameters: obj({}),
      run: () => s.listResources(ctx),
    },
    save_resource: {
      description:
        'Create or update a resource from YAML (name, briefing, keys [{name, secret}], agents). This sets key NAMES only. Values must be entered by the human with Set Value on the resource page; never ask for or accept secret values in chat.',
      parameters: obj({ yaml: str('the resource in YAML'), rename_from: str('current name, when renaming') }, ['yaml']),
      run: (a, out) => {
        const r = s.saveResource(ctx, yamlDef<s.Resource & { agents?: string[] }>(a), a.rename_from ? String(a.rename_from) : undefined);
        out.navigate = ['resources', r.name];
        return r;
      },
    },
    delete_resource: {
      description: 'Delete a resource. Destructive: only after the human confirmed.',
      parameters: obj({ name: str('resource name'), confirmed: { type: 'boolean' } }, ['name', 'confirmed']),
      run: (a) => {
        if (a.confirmed !== true) throw new HttpError(400, 'ask the human to confirm first');
        s.deleteResource(ctx, String(a.name));
        return { deleted: a.name };
      },
    },
    list_artifacts: {
      description: 'List artifacts (files agents made), optionally for one project, agent or job.',
      parameters: obj({ project: str('project name'), agent: str('agent name'), job: str('job id') }),
      run: (a) =>
        s.listArtifacts(ctx, {
          project: a.project ? String(a.project) : undefined,
          agent: a.agent ? String(a.agent) : undefined,
          job: a.job ? String(a.job) : undefined,
        }),
    },
    delete_artifacts: {
      description:
        'Delete artifacts and their files: pass ids, or a project/agent filter (or all: true for every artifact). Destructive: only after the human has confirmed in this chat, saying how many.',
      parameters: obj(
        {
          ids: { type: 'array', items: { type: 'string' } },
          project: str('only this project'),
          agent: str('only this agent'),
          all: { type: 'boolean', description: 'every artifact' },
          confirmed: { type: 'boolean' },
        },
        ['confirmed'],
      ),
      run: (a, out) => {
        if (a.confirmed !== true) throw new HttpError(400, 'ask the human to confirm first');
        const ids = Array.isArray(a.ids)
          ? (a.ids as string[])
          : a.all === true || a.project || a.agent
            ? s
                .listArtifacts(ctx, { project: a.project ? String(a.project) : undefined, agent: a.agent ? String(a.agent) : undefined })
                .map((x) => String(x.id))
            : [];
        if (!ids.length) throw new HttpError(400, 'say which artifacts: ids, a project, an agent, or all: true');
        out.navigate = ['artifacts'];
        return { deleted: s.deleteArtifacts(ctx, ids) };
      },
    },
    list_inbox: {
      description: "List the human's inbox (messages from agents), unread first.",
      parameters: obj({ unread_only: { type: 'boolean' } }),
      run: (a) => s.listMessages(ctx, { to: 'human', unread: a.unread_only === true, limit: 50 }),
    },
    message_agent: {
      description:
        'Send a message from the human to an agent (it starts a job if the agent has an inbox trigger). Use reply_to to answer a message.',
      parameters: obj(
        { to: str('agent name'), title: str('short title'), body: str('the message'), reply_to: str('message id being answered') },
        ['to', 'body'],
      ),
      run: (a) =>
        s.sendMessage(ctx, {
          from: 'human',
          to: `agent:${String(a.to).replace(/^agent:/, '')}`,
          type: a.reply_to ? 'reply' : 'info',
          title: a.title ? String(a.title) : '',
          body: String(a.body),
          reply_to: a.reply_to ? String(a.reply_to) : null,
        }),
    },
    list_examples: {
      description: 'List the example agents that can be installed.',
      parameters: obj({}),
      run: () => api(ctx, 'GET', '/api/examples'),
    },
    install_example: {
      description: 'Install an example agent, with the projects and resources it needs (it installs disabled).',
      parameters: obj({ name: str('example name') }, ['name']),
      run: async (a, out) => {
        const r = (await api(ctx, 'POST', `/api/examples/${encodeURIComponent(String(a.name))}/install`)) as { agent: s.Agent };
        out.navigate = ['agents', r.agent.name];
        return r;
      },
    },
    get_settings: {
      description: 'Read settings (keys and tokens are hidden).',
      parameters: obj({}),
      run: () => redact(ctx.settings),
    },
    update_settings: {
      description:
        'Change settings that are not secrets: global_spend_cap_usd, defaults (models, budget_usd, max_parallel, guardrails), litellm.url, dopbase.mode/url/local_port.',
      parameters: obj({ yaml: str('a partial settings object in YAML, merged into the current settings') }, ['yaml']),
      run: (a) => {
        const patch = yamlDef<Record<string, unknown>>(a);
        const banned = JSON.stringify(patch).match(/"(api_key|master_key|token)"/);
        if (banned) throw new HttpError(400, `set ${banned[1]} in the Settings page, not in chat`);
        deepMerge(ctx.settings as unknown as Record<string, unknown>, patch);
        saveSettings(ctx.settings);
        ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
        return redact(ctx.settings);
      },
    },
    open_page: {
      description:
        'Show a page in the UI: inbox, jobs, agents, projects, artifacts, resources, settings, or an item such as agents/<name>, jobs/<id>.',
      parameters: obj({ path: str('e.g. "agents/social-scout"') }, ['path']),
      run: (a, out) => {
        out.navigate = String(a.path).split('/').filter(Boolean);
        return { shown: a.path };
      },
    },
  };
}

/** Reuse an HTTP route rather than duplicating its logic. */
async function api(ctx: Ctx, method: string, path: string): Promise<unknown> {
  const res = await fetch(`${ctx.apiUrl}${path}`, { method, headers: { Authorization: `Bearer ${ctx.apiToken}` } });
  const data = await res.json();
  if (!res.ok) throw new HttpError(res.status, (data as { error?: string }).error ?? String(res.status));
  return data;
}

function redact(settings: unknown): unknown {
  return JSON.parse(JSON.stringify(settings, (k, v) => (['api_key', 'master_key', 'token'].includes(k) && v ? '(set)' : v)));
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object')
      deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}

const SYSTEM = `You are the assistant inside Yaho (Yet Another Harness Orchestrator), a desktop app where long-lived AI agents run
on schedules, work on projects, use resources whose secret key values live in Dopbase, and talk to the human through an inbox.

You can do anything the UI can, with your tools: create and edit agents, projects and resources, run and stop jobs, read
the inbox and message agents, change non-secret settings, and open pages. Act; don't just describe. Prefer one tool
call that does the whole thing (a full YAML definition) over many small ones.

- An agent definition is YAML. When creating one, write a real briefing: what it is for, its loop, its limits. Keep
  enabled: false unless the human asked to start it, and say so.
- Models are LiteLLM model names; use the defaults from get_settings unless asked.
- Never ask for, accept or repeat secret values (API keys, tokens, passwords). Create the key names and tell the human
  to enter the values with Set Value on the resource page.
- Delete only after the human confirmed in this conversation; then pass confirmed: true.
- After acting, answer in one or two short sentences saying what you did. Use plain text, no headings.`;

/** What the chat is about, when it was opened from a page (Chat About Agent, Chat About Project). */
export interface ChatFocus {
  agent?: string;
  project?: string;
}

/** The focused project: its briefing, agents, context files and recent artifacts. */
function projectFocus(ctx: Ctx, name: string): string {
  const p = s.getProject(ctx, name);
  const dir = join(ctx.paths.project(name), 'files');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const artifacts = s
    .listArtifacts(ctx, { project: name })
    .slice(0, 15)
    .map((a) => ({ id: a.id, kind: a.kind, file: a.file_path, agent: a.agent, created: a.created }));
  return [
    '',
    `## This chat is about the project "${p.name}" (${p.title})`,
    'The human opened it from that project\'s page. Questions are about this project unless they say otherwise: what it is',
    'for, which agents work on it, what they made, how to improve its briefing. When they ask for a change, make it with',
    'save_project (or save_agent to assign agents) and say what changed. When explaining, you may answer at more length',
    'than one or two sentences.',
    '',
    `Briefing:\n${p.briefing.trim() || '(empty)'}`,
    '',
    `Agents on it: ${p.agents.join(', ') || 'none'}`,
    `Context files: ${files.join(', ') || 'none'}`,
    '',
    'Recent artifacts (newest first):',
    artifacts.length ? YAML.stringify(artifacts).trim() : 'none',
  ].join('\n');
}

/** The focused agent's definition and recent activity, so the model can discuss it without a lookup first. */
function focusPrompt(ctx: Ctx, focus: ChatFocus | undefined): string {
  if (focus?.project) return projectFocus(ctx, focus.project);
  if (!focus?.agent) return '';
  const a = s.getAgent(ctx, focus.agent);
  const jobs = s.listJobs(ctx, { agent: a.name, limit: 10 }).map((j) => {
    const ses = j.session_id
      ? (ctx.db.prepare('SELECT summary FROM sessions WHERE id = ?').get(j.session_id) as { summary?: string } | undefined)
      : undefined;
    return { id: j.id, created: j.created, trigger: j.trigger_type, status: j.status, reason: j.reason, cost_usd: j.cost_usd, summary: ses?.summary };
  });
  const fence = '```';
  return [
    '',
    `## This chat is about the agent "${a.name}"`,
    'The human opened it from that agent\'s page. Questions are about this agent unless they say otherwise: how it works,',
    'why it did something, how to improve it. When they ask for a change, make it with save_agent (the whole definition,',
    'with your edits) and say what changed. When explaining, you may answer at more length than one or two sentences.',
    '',
    'Definition:',
    `${fence}yaml\n${YAML.stringify(a).trim()}\n${fence}`,
    '',
    `Stats: ${JSON.stringify(s.agentStats(ctx, a.name))}`,
    '',
    'Recent jobs (newest first; summaries are what the agent reported):',
    YAML.stringify(jobs).trim(),
  ].join('\n');
}

/** One assistant turn: call the model, run its tools, repeat until it answers. */
export async function chat(ctx: Ctx, history: ChatMessage[], focus?: ChatFocus): Promise<{ messages: ChatMessage[]; steps: Step[]; navigate?: string[] }> {
  const { litellm } = ctx.settings;
  const key = litellm.master_key ?? litellm.api_key;
  if (!litellm.url || !key) throw new HttpError(503, 'set the LiteLLM proxy URL and key in Settings first');
  const model = ctx.settings.assistant?.model ?? ctx.settings.defaults.models[0];
  if (!model) throw new HttpError(503, 'choose a default model in Settings first');
  const t = tools(ctx);
  const toolDefs = Object.entries(t).map(([name, x]) => ({
    type: 'function',
    function: { name, description: x.description, parameters: x.parameters },
  }));
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM + focusPrompt(ctx, focus) }, ...history.filter((m) => m.role !== 'system')];
  const steps: Step[] = [];
  const out: { navigate?: string[] } = {};

  for (let round = 0; round < 12; round++) {
    const res = await fetch(`${litellm.url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: toolDefs, max_tokens: 4000 }),
    });
    if (!res.ok) throw new HttpError(502, `LiteLLM: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
    const msg = j.choices[0]!.message;
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      const tool = t[call.function.name];
      let args: Record<string, unknown> = {};
      let result: unknown;
      let ok = true;
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (!tool) throw new Error(`unknown tool ${call.function.name}`);
        result = await tool.run(args, out);
      } catch (e) {
        ok = false;
        result = { error: (e as Error).message };
      }
      steps.push({ tool: call.function.name, args, ok, result });
      ctx.bus.emitEvent({ type: 'changed', entity: 'assistant' });
      const text = JSON.stringify(result ?? null);
      messages.push({ role: 'tool', tool_call_id: call.id, content: text.length > 12000 ? `${text.slice(0, 12000)}… (truncated)` : text });
    }
  }
  return { messages: messages.slice(1), steps, navigate: out.navigate };
}
