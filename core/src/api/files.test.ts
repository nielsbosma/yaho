import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { addArtifact } from '../store.ts';
import { disposition, makeTicket } from './server.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
let jobToken: string;
const posix = process.platform !== 'win32';

const api = (path: string, init: RequestInit = {}, token = ctx.apiToken) =>
  fetch(`${ctx.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-files-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'site', title: 'Site' }) });
  await api('/api/agents', { method: 'POST', body: JSON.stringify({ name: 'maker', briefing: 'b', projects: ['site'] }) });
  const t = new Date().toISOString();
  ctx.db.prepare("INSERT INTO jobs (id, agent, trigger_type, status, created) VALUES ('job_f', 'maker', 'manual', 'finished', ?)").run(t);
  jobToken = 'jt_files_test';
  ctx.db
    .prepare("INSERT INTO job_tokens (token, job, agent, expires) VALUES (?, 'job_f', 'maker', ?)")
    .run(jobToken, '2999-01-01T00:00:00Z');
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('serving files agents made', () => {
  it('sandboxes every file, and downloads pages, SVG and scripts', async () => {
    const arts = join(dir, 'projects', 'site', 'artifacts');
    mkdirSync(arts, { recursive: true });
    writeFileSync(join(arts, 'report.html'), '<script>alert(1)</script>');
    writeFileSync(join(arts, 'chart.png'), 'png');
    const page = addArtifact(ctx, { project: 'site', agent: 'maker', job: null, kind: 'report', file_path: 'report.html' });
    const png = addArtifact(ctx, { project: 'site', agent: 'maker', job: null, kind: 'image', file_path: 'chart.png' });

    const res = await api(`/api/artifacts/${page.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="report.html"; filename*=UTF-8''report.html`);

    const img = await api(`/api/artifacts/${png.id}/file`);
    expect(img.headers.get('content-security-policy')).toBe('sandbox');
    expect(img.headers.get('content-disposition')).toBeNull();
    expect(await img.text()).toBe('png');
  });

  it('names downloads in RFC 5987 form with an ASCII fallback', () => {
    expect(disposition('attachment', 'Rapport å "1".pdf')).toBe(
      `attachment; filename="Rapport _ _1_.pdf"; filename*=UTF-8''Rapport%20%C3%A5%20%221%22.pdf`,
    );
    expect(disposition('attachment', "a'b\r\n.txt")).toBe(`attachment; filename="a'b__.txt"; filename*=UTF-8''a%27b%0D%0A.txt`);
  });

  it('opens one path with a ticket, and nothing else', async () => {
    const [a] = (await (await api('/api/artifacts?project=site')).json()) as Array<{ id: string }>;
    const path = `/api/artifacts/${a!.id}/file`;
    const res = await api('/api/ticket', { method: 'POST', body: JSON.stringify({ path }) });
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket).toMatch(/^\d+\.[0-9a-f]{64}$/);

    expect((await fetch(`${ctx.apiUrl}${path}?ticket=${ticket}`)).status).toBe(200);
    expect((await fetch(`${ctx.apiUrl}${path}?ticket=${ticket}&download=1`)).status).toBe(200);
    expect((await fetch(`${ctx.apiUrl}/api/settings?ticket=${ticket}`)).status).toBe(401);
    expect((await fetch(`${ctx.apiUrl}${path}?ticket=${ticket}`, { method: 'DELETE' })).status).toBe(401);
    expect((await fetch(`${ctx.apiUrl}${path}?ticket=${ticket.replace(/.$/, (c) => (c === '0' ? '1' : '0'))}`)).status).toBe(401);
    const old = makeTicket(ctx, path, Date.now() - 6 * 60_000);
    expect((await fetch(`${ctx.apiUrl}${path}?ticket=${old}`)).status).toBe(401);

    for (const bad of ['/etc/passwd', '/api/x?y=1', 'api/x', 42])
      expect((await api('/api/ticket', { method: 'POST', body: JSON.stringify({ path: bad }) })).status).toBe(400);
    expect((await api('/api/ticket', { method: 'POST', body: JSON.stringify({ path }) }, jobToken)).status).toBe(403);
  });

  it.skipIf(!posix)('never follows a symlink out of a workspace or project', async () => {
    const ws = join(dir, 'agents', 'maker');
    mkdirSync(ws, { recursive: true });
    symlinkSync(join(dir, 'api-token'), join(ws, 'token.txt'));
    expect((await api('/api/agents/maker/workspace/file?path=token.txt')).status).toBe(400);
    const list = (await (await api('/api/agents/maker/workspace')).json()) as Array<{ path: string; dir: boolean }>;
    expect(list.find((e) => e.path === 'token.txt')).toMatchObject({ dir: false });

    // Deleting removes the link, not what it points at.
    expect((await api('/api/agents/maker/workspace/file?path=token.txt', { method: 'DELETE' })).status).toBe(200);
    expect(readFileSync(join(dir, 'api-token'), 'utf8').trim()).toBe(ctx.apiToken);

    const files = join(dir, 'projects', 'site', 'files');
    mkdirSync(files, { recursive: true });
    symlinkSync(join(dir, 'api-token'), join(files, 'leak'));
    expect((await api('/api/agent/projects/site/files/leak', {}, jobToken)).status).toBe(400);
    expect(await (await api('/api/agent/projects/site/files', {}, jobToken)).json()).toEqual([]);

    // An artifact upload does not write through a planted link.
    const arts = join(dir, 'projects', 'site', 'artifacts');
    symlinkSync(join(dir, 'yaho.db'), join(arts, 'x.png'));
    const res = await api('/api/agent/projects/site/artifacts?name=x.png&kind=image', { method: 'POST', body: 'not a database' }, jobToken);
    expect(((await res.json()) as { file: string }).file).toBe('x-2.png');
    expect(readFileSync(join(dir, 'yaho.db')).subarray(0, 15).toString()).toBe('SQLite format 3');

    rmSync(join(arts), { recursive: true });
    symlinkSync(tmpdir(), arts);
    expect((await api('/api/agent/projects/site/artifacts?name=y.png', { method: 'POST', body: 'y' }, jobToken)).status).toBe(400);
  });

  it('checks names, kinds, limits and escapes before using them', async () => {
    expect((await api('/api/agents/..%2F..%2Fetc/workspace')).status).toBe(400);
    expect((await api('/api/projects/..%2F..%2Fetc/files')).status).toBe(400);
    expect((await api('/api/agents/%E0%A4%A/workspace')).status).toBe(400);
    expect((await api('/api/jobs?limit=abc')).status).toBe(200);
    expect((await api('/api/jobs?limit=99999999')).status).toBe(200);
    expect((await api('/api/agent/projects/site/artifacts?name=z.txt&kind=%3Cb%3E', { method: 'POST', body: 'z' }, jobToken)).status).toBe(
      400,
    );
    expect((await api('/api/agent/briefing', { method: 'PUT', body: '{not json' }, jobToken)).status).toBe(400);
    expect((await api('/api/agent/sleep', { method: 'POST', body: JSON.stringify({ duration: '1e300d' }) }, jobToken)).status).toBe(400);
    const css = await (await fetch(`${ctx.apiUrl}/api/fonts/anthropic.css?base=${encodeURIComponent("x');}*{color:red")}`)).text();
    expect(css).not.toContain('color:red');
  });
});
