import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { safeJoin } from '../api/server.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';
import * as s from '../store.ts';

/** Text the chat model reads at most from one file; longer files are cut, with a note. */
const MAX_CHARS = 150_000;
const TEXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.ini', '.toml']);

function localFile(path: string): string {
  const p = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(p)) throw new HttpError(400, 'give the full path of the file, e.g. D:\\Docs\\plan.pdf');
  if (!existsSync(p) || !statSync(p).isFile()) throw new HttpError(404, `no file at ${p}`);
  return p;
}

/** Read a file on this computer as text: PDFs are extracted, text formats read as they are. */
export async function readLocalFile(path: string): Promise<{ path: string; pages?: number; text: string; truncated: boolean }> {
  const p = localFile(path);
  const ext = extname(p).toLowerCase();
  let text: string;
  let pages: number | undefined;
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(readFileSync(p)));
    const r = await extractText(doc, { mergePages: true });
    text = r.text;
    pages = r.totalPages;
  } else if (TEXT.has(ext) || statSync(p).size < 1_000_000) {
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, `${basename(p)} is not a text file or PDF`);
    text = buf.toString('utf8');
  } else throw new HttpError(415, `${basename(p)} is too large to read as text`);
  return { path: p, ...(pages ? { pages } : {}), text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

/** Copy a file on this computer into a project's context files. */
export function addProjectFile(ctx: Ctx, project: string, path: string, name?: string): { project: string; name: string } {
  s.getProject(ctx, project);
  const p = localFile(path);
  const file = basename((name || basename(p)).replaceAll('\\', '/')).trim();
  if (!file || file === '.' || file === '..') throw new HttpError(400, 'bad file name');
  const dir = join(ctx.paths.project(project), 'files');
  mkdirSync(dir, { recursive: true });
  copyFileSync(p, join(dir, file));
  ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: project });
  return { project, name: file };
}

/** Folders that are build output or caches, never worth copying into a workspace. */
const SKIP = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv', '.pytest_cache']);

/** List a folder on this computer: names, sizes and subfolders, one level deep. */
export function listLocalFolder(path: string): Array<{ name: string; dir: boolean; size?: number }> {
  const p = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(p)) throw new HttpError(400, 'give the full path of the folder, e.g. D:\Workspaces\Jobs');
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new HttpError(404, `no folder at ${p}`);
  return readdirSync(p, { withFileTypes: true }).map((d) =>
    d.isDirectory() ? { name: d.name, dir: true } : { name: d.name, dir: false, size: statSync(join(p, d.name)).size },
  );
}

/**
 * Copy a file or a whole folder on this computer into an agent's workspace (scripts, databases, data), at `dest`
 * relative to the workspace root. Caches and build folders are skipped; existing files are overwritten.
 */
export function copyToAgentWorkspace(ctx: Ctx, agent: string, path: string, dest = ''): { agent: string; dest: string; files: number } {
  s.getAgent(ctx, agent);
  const src = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(src) || !existsSync(src)) throw new HttpError(404, `no file or folder at ${src}`);
  const root = ctx.paths.agent(agent);
  const isDir = statSync(src).isDirectory();
  const target = safeJoin(root, dest.replaceAll('\\', '/') || (isDir ? '' : basename(src)));
  let files = 0;
  const copy = (from: string, to: string) => {
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const d of readdirSync(from)) if (!SKIP.has(d)) copy(join(from, d), join(to, d));
    } else {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      files++;
    }
  };
  // A file copied onto an existing folder lands inside it.
  copy(src, !isDir && existsSync(target) && statSync(target).isDirectory() ? join(target, basename(src)) : target);
  ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name: agent });
  return { agent, dest: relative(root, target) || '.', files };
}

/** Write a text file in an agent's workspace, e.g. a script rewritten for Yaho or a memory note. */
export function writeAgentFile(ctx: Ctx, agent: string, path: string, content: string): { agent: string; path: string; bytes: number } {
  s.getAgent(ctx, agent);
  const root = ctx.paths.agent(agent);
  const target = safeJoin(root, path.replaceAll('\\', '/'));
  if (target === root) throw new HttpError(400, 'give a file path inside the workspace, e.g. scripts/run.py');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name: agent });
  return { agent, path: relative(root, target).replaceAll('\\', '/'), bytes: Buffer.byteLength(content) };
}
