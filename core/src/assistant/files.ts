import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
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
