import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Req, Router } from './http.ts';

/**
 * YAHO looks like Claude Desktop by using its typefaces, Anthropic Sans and Anthropic Serif. They are Anthropic's,
 * so YAHO never ships them: when the Claude desktop app is installed on this machine, the fonts are read out of its
 * app.asar at run time. Without it, the CSS is empty and the UI falls back to system fonts.
 */

interface AsarEntry {
  offset: number;
  size: number;
}

function claudeAsar(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AnthropicClaude');
    if (existsSync(base))
      for (const d of readdirSync(base)
        .filter((d) => d.startsWith('app-'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
        candidates.push(join(base, d, 'resources', 'app.asar'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Claude.app/Contents/Resources/app.asar',
      join(homedir(), 'Applications/Claude.app/Contents/Resources/app.asar'),
    );
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Read the asar header and collect the variable Anthropic font files. */
function scan(asar: string): { file: string; dataStart: number; fonts: Map<string, AsarEntry> } {
  const fd = openSync(asar, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    const tree = JSON.parse(json.toString('utf8')) as { files: Record<string, unknown> };
    const fonts = new Map<string, AsarEntry>();
    const walk = (node: Record<string, unknown>) => {
      for (const [name, child] of Object.entries(node)) {
        const c = child as { files?: Record<string, unknown>; offset?: string; size?: number; unpacked?: boolean };
        if (c.files) walk(c.files);
        else if (!c.unpacked && c.offset !== undefined && /^Anthropic(Sans|Serif)-(Roman|Italic)-Variable-[\w-]+\.woff2$/.test(name))
          fonts.set(name, { offset: Number(c.offset), size: c.size ?? 0 });
      }
    };
    walk(tree.files);
    return { file: asar, dataStart: 8 + headerSize, fonts };
  } finally {
    closeSync(fd);
  }
}

let cache: ReturnType<typeof scan> | null | undefined;
function source() {
  if (cache === undefined) {
    try {
      const asar = claudeAsar();
      cache = asar ? scan(asar) : null;
    } catch {
      cache = null;
    }
  }
  return cache;
}

function css(base: string): string {
  const src = source();
  if (!src) return '/* Claude desktop is not installed here: system fonts are used. */\n';
  const rules: string[] = [];
  for (const name of src.fonts.keys()) {
    const m = /^Anthropic(Sans|Serif)-(Roman|Italic)/.exec(name)!;
    rules.push(
      `@font-face{font-family:'Anthropic ${m[1]}';src:url('${base}/api/fonts/${name}') format('woff2');font-weight:100 900;font-style:${m[2] === 'Italic' ? 'italic' : 'normal'};font-display:swap}`,
    );
  }
  return `${rules.join('\n')}\n`;
}

export function fontRoutes(r: Router): void {
  // Fonts load through CSS url(), which cannot send a token; they are public files, so these routes are open.
  r.on('GET', '/api/fonts/anthropic.css', (req: Req) => {
    const host = req.raw.headers.host ? `http://${req.raw.headers.host}` : '';
    req.res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'max-age=3600' });
    req.res.end(css(req.query.get('base') ?? host));
  });
  r.on('GET', '/api/fonts/:file', (req: Req) => {
    const src = source();
    const e = src?.fonts.get(req.params.file!);
    if (!src || !e) {
      req.res.writeHead(404).end();
      return;
    }
    const buf = Buffer.alloc(e.size);
    const fd = openSync(src.file, 'r');
    try {
      readSync(fd, buf, 0, e.size, src.dataStart + e.offset);
    } finally {
      closeSync(fd);
    }
    req.res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
    req.res.end(buf);
  });
}

export const OPEN_PATHS = /^\/api\/fonts\//;
