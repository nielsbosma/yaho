#!/usr/bin/env node
/**
 * yaho: the agent's side of Yaho. Speaks YAML: input on stdin or flags, output on stdout.
 * Needs YAHO_API_URL and YAHO_JOB_TOKEN, which Yaho puts in every job's environment.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';
import { LAUNCHER_COMMANDS, launcher, version } from './launcher.ts';

const HELP = `yaho - talk to the Yaho orchestrator from inside a job

  yaho inbox list [--all]               unread messages (or all)
  yaho inbox read <id>                  one message with its thread
  yaho inbox mark-read <id> [--unread]  mark handled (or back to unread)
  yaho send --to human|agent:<name> [--type question|instruction|info] [--title T] [--body B] [--reply-to ID] < msg.yaml
  yaho query agents|projects|resources|jobs
  yaho project files <project> [<file> [--out <path>]]
  yaho artifact add <project> <file> [--kind <kind>]
  yaho briefing show
  yaho briefing update < briefing.md
  yaho resource keys <resource>
  yaho tools <resource> [--search words]   tools of a Composio resource
  yaho tool <resource> <TOOL_SLUG> < args.yaml   run one (arguments as YAML)
  yaho idea --title "..." < idea.md     suggest a feature for Yaho itself (a GitHub issue)
  yaho email send --to a@b.com[,c@d.com] [--cc ...] --subject "..." [--body B] < body.txt
  yaho email reply <message-id> [--to ...] [--cc ...] [--body B] < body.txt
  yaho sms send --to +46701234567 [--body B] < text.txt
  yaho sms reply <message-id> [--body B] < text.txt
  yaho budget
  yaho sleep <duration>                 e.g. 30m, 2h, 1d; ends this job now
  yaho finish [--summary "..."]         ends this job now
`;

class CliError extends Error {}

const apiUrl = process.env.YAHO_API_URL;
const token = process.env.YAHO_JOB_TOKEN;
/** In Sandbox Mode the job has its own network: the core is reached through its Unix socket instead of apiUrl. */
const socket = process.env.YAHO_API_SOCKET;

interface Reply {
  status: number;
  ok: boolean;
  type: string;
  body: Buffer;
}

/** One request to the core, over its socket when there is one, else over HTTP. */
function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> } = {}): Promise<Reply> {
  if (!socket)
    return fetch(`${apiUrl}${path}`, init).then(async (r) => ({
      status: r.status,
      ok: r.ok,
      type: r.headers.get('content-type') ?? '',
      body: Buffer.from(await r.arrayBuffer()),
    }));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: socket, path, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) < 300, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(parts) }),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

async function call(method: string, path: string, body?: unknown, raw?: Buffer | string, contentType?: string): Promise<unknown> {
  if (!apiUrl || !token) throw new CliError('YAHO_API_URL and YAHO_JOB_TOKEN are not set: yaho only works inside a Yaho job');
  const res = await request(`/api/agent${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/yaml',
      'Content-Type': contentType ?? (raw !== undefined ? 'application/octet-stream' : 'application/json'),
    },
    body: raw === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : typeof raw === 'string' ? raw : new Uint8Array(raw),
  });
  const text = res.body.toString('utf8');
  const ct = res.type;
  if (!ct.includes('yaml') && !ct.includes('json')) {
    if (!res.ok) throw new CliError(`${res.status} ${text}`);
    return text;
  }
  const data = text ? YAML.parse(text) : null;
  if (!res.ok) throw new CliError((data as { error?: string })?.error ?? `${res.status}`);
  return data;
}

function readStdin(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const out = (v: unknown): void => void process.stdout.write(typeof v === 'string' ? (v.endsWith('\n') ? v : `${v}\n`) : YAML.stringify(v));

async function main(argv: string[]): Promise<void> {
  const { positionals: p, values: f } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      unread: { type: 'boolean' },
      to: { type: 'string' },
      type: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      'reply-to': { type: 'string' },
      out: { type: 'string' },
      kind: { type: 'string' },
      summary: { type: 'string' },
      search: { type: 'string' },
      subject: { type: 'string' },
      cc: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, sub, a1, a2] = p;
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new CliError(`missing ${what}\n\n${HELP}`);
    return v;
  };
  if (!cmd || f.help) return void out(HELP);

  switch (cmd) {
    case 'inbox':
      if (sub === 'list' || !sub) return out(await call('GET', `/inbox${f.all ? '?all=1' : ''}`));
      if (sub === 'read') return out(await call('GET', `/inbox/${need(a1, 'message id')}`));
      if (sub === 'mark-read') return out(await call('POST', `/inbox/${need(a1, 'message id')}/read`, { read: !f.unread }));
      break;
    case 'send': {
      const stdin = readStdin();
      const msg = (stdin.trim() ? YAML.parse(stdin) : {}) as Record<string, unknown>;
      if (f.to) msg.to = f.to;
      if (f.type) msg.type = f.type;
      if (f.title) msg.title = f.title;
      if (f.body) msg.body = f.body;
      if (f['reply-to']) msg.reply_to = f['reply-to'];
      need(msg.to as string, '--to human|agent:<name>');
      return out(await call('POST', '/send', msg));
    }
    case 'query':
      return out(await call('GET', `/query/${need(sub, 'what to query: agents, projects, resources or jobs')}`));
    case 'project':
      if (sub === 'files') {
        const project = need(a1, 'project name');
        if (!a2) return out(await call('GET', `/projects/${encodeURIComponent(project)}/files`));
        const res = await request(`/api/agent/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(a2)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new CliError(`${res.status} ${res.body.toString('utf8')}`);
        const buf = res.body;
        const target = f.out ?? a2;
        writeFileSync(target, buf);
        return out({ saved: target, bytes: buf.length });
      }
      break;
    case 'artifact':
      if (sub === 'add') {
        const project = need(a1, 'project name');
        const file = need(a2, 'file path');
        const q = new URLSearchParams({ name: basename(file), kind: f.kind ?? 'file' });
        return out(await call('POST', `/projects/${encodeURIComponent(project)}/artifacts?${q}`, undefined, readFileSync(file)));
      }
      break;
    case 'briefing':
      if (sub === 'show' || !sub) return out(((await call('GET', '/briefing')) as { briefing: string }).briefing);
      if (sub === 'update') {
        const text = readStdin();
        if (!text.trim()) throw new CliError('pipe the new briefing on stdin: yaho briefing update < briefing.md');
        return out(await call('PUT', '/briefing', undefined, text, 'text/markdown; charset=utf-8'));
      }
      break;
    case 'resource':
      if (sub === 'keys') return out(await call('GET', `/resources/${encodeURIComponent(need(a1, 'resource name'))}/keys`));
      break;
    case 'tools': {
      const q = f.search ? `?search=${encodeURIComponent(f.search)}` : '';
      const tools = (await call('GET', `/resources/${encodeURIComponent(need(sub, 'resource name'))}/tools${q}`)) as Array<
        Record<string, unknown>
      >;
      return out(tools.map((t) => ({ slug: t.slug, description: t.description, input: t.input_parameters })));
    }
    case 'tool': {
      const stdin = readStdin();
      const args = stdin.trim() ? YAML.parse(stdin) : {};
      return out(
        await call(
          'POST',
          `/resources/${encodeURIComponent(need(sub, 'resource name'))}/tools/${encodeURIComponent(need(a1, 'tool slug'))}`,
          args ?? {},
        ),
      );
    }
    case 'idea': {
      const body = readStdin().trim() || f.body;
      return out(await call('POST', '/idea', { title: need(f.title, '--title "..."'), body: need(body, 'the idea as Markdown on stdin (or --body)') }));
    }
    case 'email': {
      if (sub !== 'send' && sub !== 'reply') break;
      const body = readStdin().trim() || f.body;
      const reply_to = sub === 'reply' ? need(a1, 'the message id to reply to') : undefined;
      if (sub === 'send') {
        need(f.to, '--to a@b.com');
        need(f.subject, '--subject "..."');
      }
      return out(await call('POST', '/email', { to: f.to, cc: f.cc, subject: f.subject, body: need(body, 'the body on stdin (or --body)'), reply_to }));
    }
    case 'sms': {
      if (sub !== 'send' && sub !== 'reply') break;
      const body = readStdin().trim() || f.body;
      const reply_to = sub === 'reply' ? need(a1, 'the message id to reply to') : undefined;
      if (sub === 'send') need(f.to, '--to +46701234567');
      return out(await call('POST', '/sms', { to: f.to, body: need(body, 'the text on stdin (or --body)'), reply_to }));
    }
    case 'budget':
      return out(await call('GET', '/budget'));
    case 'sleep':
      return out(await call('POST', '/sleep', { duration: need(sub, 'duration, e.g. 30m') }));
    case 'finish':
      return out(await call('POST', '/finish', { summary: f.summary }));
  }
  throw new CliError(`unknown command: ${p.join(' ')}\n\n${HELP}`);
}

/**
 * Outside a job (no job token) the command belongs to the human: bare `yaho` opens the app, and open, doctor,
 * shortcut, serve, update and --version are handled by the launcher. Inside a job everything is the agent's CLI.
 */
async function entry(argv: string[]): Promise<void> {
  const [first] = argv;
  if (first === '--version' || first === '-v') return void out(version());
  if (!token && (!first || LAUNCHER_COMMANDS.has(first))) {
    const code = await launcher(first, argv.slice(1));
    if (code > 0) process.exit(code);
    return;
  }
  if (!token && (first === '--help' || first === '-h' || first === 'help')) return void out(`${HUMAN_HELP}\n${HELP}`);
  return main(argv);
}

const HUMAN_HELP = `yaho - Yet Another Harness Orchestrator

  yaho                    open the app (or bring it to the front)
  yaho doctor             check the install: app, Node, Claude Code, data folder, core
  yaho shortcut [--remove] make (or remove) the desktop and Start menu shortcuts
  yaho serve              run the core without a window
  yaho update             update to the latest version
  yaho --version
`;

entry(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`yaho: ${e instanceof CliError ? e.message : (e as Error).stack}\n`);
  process.exit(1);
});
