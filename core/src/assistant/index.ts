import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { saveSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';
import { addProjectFile, copyToAgentWorkspace, listLocalFolder, readLocalFile, writeAgentFile } from './files.ts';
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
    read_file: {
      description:
        'Read a file on this computer by its full path, as text. PDFs are extracted to text; text formats (md, txt, csv, json, yaml, html...) are read as they are. Use it when the human points at a file, e.g. to write a briefing from a document.',
      parameters: obj({ path: str('full path, e.g. D:\\Docs\\plan.pdf') }, ['path']),
      run: (a) => readLocalFile(String(a.path)),
    },
    add_project_file: {
      description: "Copy a file on this computer into a project's context files, where its agents can read it.",
      parameters: obj(
        { project: str('project name'), path: str('full path of the file'), name: str('file name in the project (default: the same)') },
        ['project', 'path'],
      ),
      run: (a) => addProjectFile(ctx, String(a.project), String(a.path), a.name ? String(a.name) : undefined),
    },
    list_folder: {
      description: 'List a folder on this computer by its full path (names, sizes, subfolders; one level). Use it to see what a folder holds before reading or copying.',
      parameters: obj({ path: str('full path, e.g. D:\\Workspaces\\Jobs') }, ['path']),
      run: (a) => listLocalFolder(String(a.path)),
    },
    copy_to_agent_workspace: {
      description:
        "Copy a file or a whole folder on this computer into an agent's workspace (its working directory), e.g. scripts into scripts/ or a SQLite database to agent.db. This is how an existing script or database becomes the agent's own; project files are only context. Caches like __pycache__ are skipped.",
      parameters: obj(
        {
          agent: str('agent name'),
          path: str('full path of the file or folder'),
          dest: str('where in the workspace, relative to its root: e.g. scripts/ or agent.db (default: same name at the root; a folder copies its contents into the root)'),
        },
        ['agent', 'path'],
      ),
      run: (a) => copyToAgentWorkspace(ctx, String(a.agent), String(a.path), a.dest ? String(a.dest) : undefined),
    },
    write_agent_file: {
      description:
        "Create or overwrite a text file in an agent's workspace, e.g. a script adapted to Yaho (keys from environment variables, the database at agent.db) or a memory/ note. Read the original first and write the whole file.",
      parameters: obj({ agent: str('agent name'), path: str('path relative to the workspace root, e.g. scripts/run.py'), content: str('the full file content') }, [
        'agent',
        'path',
        'content',
      ]),
      run: (a) => writeAgentFile(ctx, String(a.agent), String(a.path), String(a.content)),
    },
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
    list_folders: {
      description: 'List the sidebar folders that group agents, with the agents in each and the ungrouped ones.',
      parameters: obj({}),
      run: () => {
        const agents = s.listAgents(ctx);
        return {
          folders: s.listFolders(ctx).map((f) => ({ name: f, agents: agents.filter((a) => a.folder === f).map((a) => a.name) })),
          ungrouped: agents.filter((a) => !a.folder).map((a) => a.name),
        };
      },
    },
    move_agents_to_folder: {
      description:
        'Put agents in a sidebar folder (creating the folder if it does not exist), or take them out with folder: null. Folders are not part of an agent definition; this is the only way to change them.',
      parameters: obj(
        { agents: { type: 'array', items: { type: 'string' } }, folder: { type: ['string', 'null'], description: 'folder name, or null for no folder' } },
        ['agents'],
      ),
      run: (a) => {
        const folder = a.folder ? String(a.folder).trim() : null;
        if (folder && !s.listFolders(ctx).includes(folder)) s.createFolder(ctx, folder);
        const names = (a.agents as unknown[]).map(String);
        for (const n of names) s.moveAgentToFolder(ctx, n, folder);
        ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
        return { moved: names, folder };
      },
    },
    manage_folder: {
      description:
        'Rename a sidebar folder, or delete it. Deleting keeps its agents (they become ungrouped) unless delete_agents is true, which deletes them too: only after the human confirmed, with confirmed: true.',
      parameters: obj(
        {
          folder: str('folder name'),
          rename_to: str('new name'),
          delete: { type: 'boolean' },
          delete_agents: { type: 'boolean' },
          confirmed: { type: 'boolean' },
        },
        ['folder'],
      ),
      run: (a) => {
        const f = String(a.folder);
        let out: string[];
        if (a.delete === true) {
          if (a.delete_agents === true && a.confirmed !== true) throw new HttpError(400, 'ask the human to confirm deleting the agents first');
          out = s.deleteFolder(ctx, f, { agents: a.delete_agents === true });
        } else if (a.rename_to) out = s.renameFolder(ctx, f, a.rename_to);
        else throw new HttpError(400, 'pass rename_to or delete: true');
        ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
        return { folders: out };
      },
    },
    query_messages: {
      description:
        "Search every message: the human's inbox, what the human sent, and messages between agents. Filters combine. Returns the total that matched and the newest matches with bodies cut to 600 characters; use read_message for a full message and its thread. For 'my inbox' use direction to_human.",
      parameters: obj({
        text: str('words that must all appear in the title or body'),
        agent: str('agent name: messages it sent or received'),
        direction: { type: 'string', enum: ['to_human', 'from_human', 'between_agents'] },
        type: { type: 'string', enum: ['question', 'instruction', 'info', 'reply'] },
        unread: { type: 'boolean', description: 'only unread messages' },
        since: str('ISO date or datetime, inclusive, e.g. 2026-10-01'),
        until: str('ISO date or datetime, inclusive'),
        limit: { type: 'number', description: 'at most this many (default 30, max 200)' },
      }),
      run: (a) => {
        const r = s.searchMessages(ctx, {
          ...(a.text ? { text: String(a.text) } : {}),
          ...(a.agent ? { agent: String(a.agent) } : {}),
          ...(a.direction ? { direction: a.direction as s.MessageQuery['direction'] } : {}),
          ...(a.type ? { type: a.type as s.Message['type'] } : {}),
          ...(a.unread === true ? { unread: true } : {}),
          ...(a.since ? { since: String(a.since) } : {}),
          ...(a.until ? { until: String(a.until) } : {}),
          ...(a.limit ? { limit: Number(a.limit) } : {}),
        });
        return {
          total: r.total,
          shown: r.messages.length,
          messages: r.messages.map((m) => ({ ...m, body: m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body })),
        };
      },
    },
    read_message: {
      description: 'Read one message in full, with its whole thread (the message it answers and every reply).',
      parameters: obj({ id: str('message id') }, ['id']),
      run: (a) => ({ message: s.getMessage(ctx, String(a.id)), thread: s.thread(ctx, String(a.id)) }),
    },
    mark_messages_read: {
      description: "Mark messages in the human's inbox read (or unread with read: false), e.g. after summarising them.",
      parameters: obj({ ids: { type: 'array', items: { type: 'string' } }, read: { type: 'boolean' } }, ['ids']),
      run: (a) => {
        const ids = (a.ids as unknown[]).map(String);
        for (const id of ids) s.markRead(ctx, id, a.read !== false, 'human');
        return { marked: ids.length, read: a.read !== false };
      },
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

You can do anything the UI can, with your tools: create and edit agents, projects and resources, read files on this
computer and copy them into projects or agent workspaces, run and stop jobs, read
search and read all messages (inbox, sent, between agents), message agents, change non-secret settings, and open pages. Act; don't just describe. Prefer one tool
call that does the whole thing (a full YAML definition) over many small ones.

- An agent definition is YAML. When creating one, write a real briefing: what it is for, its loop, its limits. Keep
  enabled: false unless the human asked to start it, and say so.
- Models are LiteLLM model names; use the defaults from get_settings unless asked.
- Sidebar folders group agents and are not in the agent YAML: use list_folders, move_agents_to_folder and manage_folder.
- Migrating existing work into an agent (scripts, a SQLite database, data files): list_folder to see it, then
  copy_to_agent_workspace into the agent's workspace (scripts/, the database as agent.db), and adapt what must change
  with read_file and write_agent_file (keys from the resources' environment variables, paths to the workspace).
  Finish the migration yourself; do not leave it to the agent's first run. Project files are context for reading only.
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
