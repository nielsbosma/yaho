import {
  constants,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { serverMode } from '../api/session.ts';
import type { Ctx } from '../context.ts';
import { assertUnder, isLink, joinUnder, resolveUnder, UnsafePathError, writeFileUnder } from '../fsSafe.ts';
import { coreFiles } from '../harness/sandbox.ts';
import { HttpError } from '../store.ts';
import * as s from '../store.ts';

/** Text the chat model reads at most from one file; longer files are cut, with a note. */
const MAX_CHARS = 150_000;
const TEXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.ini',
  '.toml',
]);

const under = (root: string, p: string) => {
  try {
    assertUnder(root, p);
    return true;
  } catch {
    return false;
  }
};

/**
 * What the chat's file tools may touch. Never the core's own files in the data folder (the API token, the database,
 * settings, the sign-in secret, Dopbase's data) or /proc, wherever a path or link points. In the server version only
 * the agents' workspaces and the projects: the chat runs as the core, and what it reads may steer it.
 */
function guardPath(ctx: Ctx, p: string): void {
  const r = ctx.paths;
  const core = coreFiles(r);
  if ([...core, '/proc'].some((c) => under(c, p))) throw new HttpError(403, `${p} is Yaho's own file; the chat cannot read or copy it`);
  if (serverMode() && ![r.agents, r.projects].some((root) => under(root, p)))
    throw new HttpError(
      403,
      `in the server version the chat only reaches the agents' workspaces (${r.agents}) and the projects (${r.projects})`,
    );
}

function localPath(ctx: Ctx, path: string, what: 'file' | 'folder'): string {
  const p = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(p))
    throw new HttpError(
      400,
      what === 'file'
        ? 'give the full path of the file, e.g. D:\\Docs\\plan.pdf'
        : 'give the full path of the folder, e.g. D:\\Workspaces\\Jobs',
    );
  if (!existsSync(p) || (what === 'file' ? !statSync(p).isFile() : !statSync(p).isDirectory()))
    throw new HttpError(404, `no ${what} at ${p}`);
  guardPath(ctx, p);
  // The real path: a link swapped in after the check leads nowhere new.
  return realpathSync(p);
}

const localFile = (ctx: Ctx, path: string) => localPath(ctx, path, 'file');

/** Paths in an agent's workspace, which the agent can fill with links: an HTTP error instead of UnsafePathError. */
function workspacePath<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof UnsafePathError) throw new HttpError(400, e.message === 'bad path' ? 'bad path' : `bad path: ${e.message}`);
    throw e;
  }
}

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
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
    return unxml(
      part('word/document.xml')
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:p>/g, '\n'),
    ).replace(/\n{3,}/g, '\n\n');
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
  ctx: Ctx,
  path: string,
): Promise<{ path: string; pages?: number; text: string; truncated: boolean } | { path: string; image: string; bytes: number }> {
  const p = localFile(ctx, path);
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
    if (buf.subarray(0, 8000).includes(0))
      throw new HttpError(415, `${basename(p)} is not a format Yaho can read (text, PDF, Office, image)`);
    text = buf.toString('utf8');
  } else throw new HttpError(415, `${basename(p)} is too large to read as text`);
  return { path: p, ...(pages ? { pages } : {}), text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

/** Copy a file on this computer into a project's context files. */
export function addProjectFile(ctx: Ctx, project: string, path: string, name?: string): { project: string; name: string } {
  s.getProject(ctx, project);
  const p = localFile(ctx, path);
  const file = basename((name || basename(p)).replaceAll('\\', '/')).trim();
  if (!file || file === '.' || file === '..') throw new HttpError(400, 'bad file name');
  const dir = join(ctx.paths.project(project), 'files');
  // Agents on the project can write in its folder: no link may redirect the copy.
  workspacePath(() => writeFileUnder(ctx.paths.project(project), join(dir, file), readFileSync(p)));
  ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: project });
  return { project, name: file };
}

/** Folders that are build output or caches, never worth copying into a workspace. */
const SKIP = new Set(['__pycache__', 'node_modules', '.git', '.venv', 'venv', '.pytest_cache']);
/** What one copy may bring into a workspace: enough for scripts, data and a database, not a whole drive. */
const COPY_LIMIT = { files: 5000, bytes: 1024 ** 3 };

/** List a folder on this computer: names, sizes and subfolders, one level deep. Entries that cannot be read say so. */
export function listLocalFolder(ctx: Ctx, path: string): Array<{ name: string; dir: boolean; size?: number; error?: string }> {
  const p = localPath(ctx, path, 'folder');
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
  const given = path.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(given) || !existsSync(given)) throw new HttpError(404, `no file or folder at ${resolve(given)}`);
  guardPath(ctx, given);
  const src = realpathSync(given);
  const root = ctx.paths.agent(agent);
  const isDir = (await stat(src)).isDirectory();
  let target = workspacePath(() => resolveUnder(root, dest.replaceAll('\\', '/') || (isDir ? '' : basename(src))));
  // A file copied onto an existing folder lands inside it.
  if (!isDir && existsSync(target) && (await lstat(target)).isDirectory()) target = join(target, basename(src));
  // Copying a folder into itself would recurse until the disk fills.
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
  if (isDir && inside(join(existsSync(root) ? realpathSync(root) : root, relative(root, target)), src))
    throw new HttpError(400, `cannot copy ${src} into a folder inside itself`);

  // Measure before copying anything. Links inside the source are skipped: they may point anywhere.
  let files = 0;
  let bytes = 0;
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    if (st.isSymbolicLink()) return;
    if (!st.isDirectory()) {
      guardPath(ctx, p);
      files++;
      bytes += st.size;
      if (files > COPY_LIMIT.files || bytes > COPY_LIMIT.bytes)
        throw new HttpError(
          413,
          `too much to copy (over ${COPY_LIMIT.files} files or ${COPY_LIMIT.bytes / 1024 ** 3} GB): pick a smaller folder`,
        );
      return;
    }
    for (const d of await readdir(p)) if (!SKIP.has(d)) await walk(join(p, d));
  };
  await walk(src);

  await workspacePath(() => copyTree(root, src, target));
  ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name: agent });
  return { agent, dest: relative(root, target).replaceAll('\\', '/') || '.', files, bytes };
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Copy src to dest under root (the agent's workspace) without writing through a link the agent may have put there. */
async function copyTree(root: string, src: string, dest: string): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (isLink(dest)) throw new UnsafePathError(`${relative(root, dest)} is a link`);
    await mkdir(dest, { recursive: true });
    assertUnder(root, dest);
    for (const d of await readdir(src)) if (!SKIP.has(d)) await copyTree(root, join(src, d), join(dest, d));
    return;
  }
  if (!st.isFile()) return;
  joinUnder(root, dest);
  await mkdir(dirname(dest), { recursive: true });
  assertUnder(root, dirname(dest));
  if (isLink(dest)) throw new UnsafePathError(`${relative(root, dest)} is a link`);
  const fd = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o666);
  await pipeline(createReadStream(src), createWriteStream(dest, { fd }));
}

/** Write a text file in an agent's workspace, e.g. a script rewritten for Yaho or a memory note. */
export function writeAgentFile(ctx: Ctx, agent: string, path: string, content: string): { agent: string; path: string; bytes: number } {
  s.getAgent(ctx, agent);
  const root = ctx.paths.agent(agent);
  const target = workspacePath(() => joinUnder(root, path.replaceAll('\\', '/')));
  if (target === root) throw new HttpError(400, 'give a file path inside the workspace, e.g. scripts/run.py');
  workspacePath(() => writeFileUnder(root, target, content));
  ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name: agent });
  return { agent, path: relative(root, target).replaceAll('\\', '/'), bytes: Buffer.byteLength(content) };
}
