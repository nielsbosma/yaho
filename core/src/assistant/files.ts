import { chownSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
/** Vision models take images up to about 5 MB. */
const MAX_IMAGE = 5 * 1024 * 1024;

const unxml = (x: string) =>
  x
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/** The text of a Word, PowerPoint or Excel file (Office Open XML is a zip of XML parts). */
async function officeText(p: string, ext: string): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate');
  // Only the XML parts read below, each at most 50 MB unpacked: a small zip can unpack to gigabytes.
  const wanted = /^(word\/document|ppt\/slides\/slide\d+|xl\/sharedStrings|xl\/workbook|xl\/worksheets\/sheet\d+)\.xml$/;
  const zip = unzipSync(new Uint8Array(readFileSync(p)), { filter: (f) => wanted.test(f.name) && f.originalSize <= 50e6 });
  const part = (name: string) => (zip[name] ? strFromU8(zip[name]) : '');
  const byNumber = (re: RegExp) =>
    Object.keys(zip)
      .filter((n) => re.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  if (ext === '.docx')
    return unxml(part('word/document.xml').replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n')).replace(/\n{3,}/g, '\n\n');
  if (ext === '.pptx')
    return byNumber(/^ppt\/slides\/slide\d+\.xml$/)
      .map((n, i) => `## Slide ${i + 1}\n` + unxml(part(n).replace(/<\/a:p>/g, '\n')).trim())
      .join('\n\n');
  // xlsx: each sheet as tab-separated rows, with shared strings resolved.
  const shared = [...part('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml(m[1]!));
  const names = [...part('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]!));
  return byNumber(/^xl\/worksheets\/sheet\d+\.xml$/)
    .map((n, i) => {
      const rows = [...part(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? '')?.[1] ?? '';
            return /t="s"/.test(c[1]!) ? (shared[Number(v)] ?? '') : unxml(v);
          })
          .join('\t'),
      );
      return `## ${names[i] ?? `Sheet ${i + 1}`}\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

/**
 * Read a file on this computer: PDFs and Office files (docx, xlsx, pptx) are extracted to text, text formats read as
 * they are, and images come back as a data URL the chat hands to the model to look at.
 */
export async function readLocalFile(
  path: string,
): Promise<{ path: string; pages?: number; text: string; truncated: boolean } | { path: string; image: string; bytes: number }> {
  const p = localFile(path);
  const ext = extname(p).toLowerCase();
  let text: string;
  let pages: number | undefined;
  if (IMAGES[ext]) {
    const buf = readFileSync(p);
    if (buf.length > MAX_IMAGE) throw new HttpError(413, `${basename(p)} is over 5 MB, too large to look at`);
    return { path: p, image: `data:${IMAGES[ext]};base64,${buf.toString('base64')}`, bytes: buf.length };
  }
  if (ext === '.docx' || ext === '.xlsx' || ext === '.pptx') {
    text = await officeText(p, ext);
  } else if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(readFileSync(p)));
    const r = await extractText(doc, { mergePages: true });
    text = r.text;
    pages = r.totalPages;
  } else if (TEXT.has(ext) || statSync(p).size < 1_000_000) {
    const buf = readFileSync(p);
    if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, `${basename(p)} is not a format Yaho can read (text, PDF, Office, image)`);
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
  writeFileSync(join(dir, file), readFileSync(p)); // not copyFileSync: it keeps the source's group, which agents cannot read
  ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: project });
  return { project, name: file };
}

/** Folders that are build output or caches, never worth copying into a workspace. */
const SKIP = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv', '.pytest_cache']);
/** What one copy may bring into a workspace: enough for scripts, data and a database, not a whole drive. */
const COPY_LIMIT = { files: 5000, bytes: 1024 ** 3 };

/** List a folder on this computer: names, sizes and subfolders, one level deep. Entries that cannot be read say so. */
export function listLocalFolder(path: string): Array<{ name: string; dir: boolean; size?: number; error?: string }> {
  const p = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(p)) throw new HttpError(400, 'give the full path of the folder, e.g. D:\\Workspaces\\Jobs');
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new HttpError(404, `no folder at ${p}`);
  return readdirSync(p, { withFileTypes: true }).map((d) => {
    if (d.isDirectory()) return { name: d.name, dir: true };
    try {
      return { name: d.name, dir: false, size: statSync(join(p, d.name)).size };
    } catch (e) {
      // A locked system file or a dangling link: listed, not fatal.
      return { name: d.name, dir: false, error: (e as NodeJS.ErrnoException).code ?? 'unreadable' };
    }
  });
}

/**
 * Copy a file or a whole folder on this computer into an agent's workspace (scripts, databases, data), at `dest`
 * relative to the workspace root. Caches and build folders are skipped; existing files are overwritten. Measured
 * first and refused above COPY_LIMIT; the copy itself is async, so the core keeps serving while it runs.
 */
export async function copyToAgentWorkspace(
  ctx: Ctx,
  agent: string,
  path: string,
  dest = '',
): Promise<{ agent: string; dest: string; files: number; bytes: number }> {
  s.getAgent(ctx, agent);
  const src = resolve(path.trim().replace(/^"(.*)"$/, '$1'));
  if (!isAbsolute(path.trim().replace(/^"(.*)"$/, '$1')) || !existsSync(src)) throw new HttpError(404, `no file or folder at ${src}`);
  const root = ctx.paths.agent(agent);
  const isDir = (await stat(src)).isDirectory();
  let target = safeJoin(root, dest.replaceAll('\\', '/') || (isDir ? '' : basename(src)));
  // A file copied onto an existing folder lands inside it.
  if (!isDir && existsSync(target) && (await stat(target)).isDirectory()) target = join(target, basename(src));
  // Copying a folder into itself would recurse until the disk fills.
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
  if (isDir && inside(target, src)) throw new HttpError(400, `cannot copy ${src} into a folder inside itself`);

  // Measure before copying anything.
  let files = 0;
  let bytes = 0;
  const walk = async (p: string): Promise<void> => {
    const st = await stat(p);
    if (!st.isDirectory()) {
      files++;
      bytes += st.size;
      if (files > COPY_LIMIT.files || bytes > COPY_LIMIT.bytes)
        throw new HttpError(413, `too much to copy (over ${COPY_LIMIT.files} files or ${COPY_LIMIT.bytes / 1024 ** 3} GB): pick a smaller folder`);
      return;
    }
    for (const d of await readdir(p)) if (!SKIP.has(d)) await walk(join(p, d));
  };
  await walk(src);

  await mkdir(dirname(target), { recursive: true });
  await cp(src, target, { recursive: true, force: true, filter: (from) => !SKIP.has(basename(from)) || from === src });
  shareWithAgents(target);
  ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name: agent });
  return { agent, dest: relative(root, target).replaceAll('\\', '/') || '.', files, bytes };
}

/** On a server a copy keeps the core's group; give it the agents' group (YAHO_AGENT_GID) so they can read it. */
function shareWithAgents(path: string): void {
  const gid = Number(process.env.YAHO_AGENT_GID);
  if (!gid || process.platform === 'win32') return;
  chownSync(path, -1, gid);
  if (statSync(path).isDirectory()) for (const e of readdirSync(path)) shareWithAgents(join(path, e));
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
