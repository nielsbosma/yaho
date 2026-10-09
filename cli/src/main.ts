#!/usr/bin/env node
/**
 * yaho: the agent's side of Yaho. Speaks YAML: input on stdin or flags, output on stdout.
 * Needs YAHO_API_URL and YAHO_JOB_TOKEN, which Yaho puts in every job's environment.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import YAML from 'yaml';

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
  yaho budget
  yaho sleep <duration>                 e.g. 30m, 2h, 1d; ends this job now
  yaho finish [--summary "..."]         ends this job now
`;

class CliError extends Error {}

const apiUrl = process.env.YAHO_API_URL;
const token = process.env.YAHO_JOB_TOKEN;

async function call(method: string, path: string, body?: unknown, raw?: Buffer | string, contentType?: string): Promise<unknown> {
  if (!apiUrl || !token) throw new CliError('YAHO_API_URL and YAHO_JOB_TOKEN are not set: yaho only works inside a Yaho job');
  const res = await fetch(`${apiUrl}/api/agent${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/yaml',
      'Content-Type': contentType ?? (raw !== undefined ? 'application/octet-stream' : 'application/json'),
    },
    body: raw === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : typeof raw === 'string' ? raw : new Uint8Array(raw),
  });
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
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
        const res = await fetch(`${apiUrl}/api/agent/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(a2)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new CliError(`${res.status} ${await res.text()}`);
        const buf = Buffer.from(await res.arrayBuffer());
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
    case 'budget':
      return out(await call('GET', '/budget'));
    case 'sleep':
      return out(await call('POST', '/sleep', { duration: need(sub, 'duration, e.g. 30m') }));
    case 'finish':
      return out(await call('POST', '/finish', { summary: f.summary }));
  }
  throw new CliError(`unknown command: ${p.join(' ')}\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`yaho: ${e instanceof CliError ? e.message : (e as Error).stack}\n`);
  process.exit(1);
});
