import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import { serve } from '../serve.ts';
import { codex, codexOverride } from './codex.ts';
import { claudeSandboxSettings, sandboxGuardScript } from './sandbox.ts';

const dir = mkdtempSync(join(tmpdir(), 'yaho-sandbox-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the sandbox guard', () => {
  const guard = join(dir, 'guard.cjs');
  writeFileSync(guard, sandboxGuardScript());
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  const outside = mkdtempSync(join(process.cwd(), '.yaho-outside-'));
  afterAll(() => rmSync(outside, { recursive: true, force: true }));
  const run = (file: string) =>
    spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ cwd: ws, tool_name: 'Write', tool_input: { file_path: file } }),
      encoding: 'utf8',
    });

  it('lets file tools write in the workspace and refuses anywhere else', () => {
    expect(run('notes/a.md').status).toBe(0);
    expect(run(join(ws, 'b.md')).status).toBe(0);
    const out = run(join(outside, 'c.md'));
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('Sandbox Mode');
    expect(run(relative(ws, join(outside, 'e.md'))).status).toBe(2);
  });

  it('follows links out of the workspace', () => {
    symlinkSync(outside, join(ws, 'link'));
    expect(run('link/d.md').status).toBe(2);
  });

  it('refuses a tool call it cannot read', () => {
    const out = spawnSync(process.execPath, [guard], { input: '{not json', encoding: 'utf8' });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('refused');
  });

  it('turns on the sandbox with the guard as a hook and no way out', () => {
    const token = join(dir, 'api-token');
    writeFileSync(token, 'secret');
    const s = claudeSandboxSettings('guard-cmd', { socket: '/data/bin/yaho.sock', denyRead: [token] }) as {
      sandbox: { network: Record<string, unknown>; filesystem: { denyRead: string[] } } & Record<string, unknown>;
      permissions: { deny: string[] };
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('guard-cmd');
    expect(s.sandbox.filesystem.denyRead).toContain(token);
    expect(s.permissions.deny).toContain(`Read(/${token})`);
    if (process.platform === 'darwin')
      expect(s.sandbox.network).toEqual({ allowedDomains: ['*'], allowUnixSockets: ['/data/bin/yaho.sock'] });
  });
});

describe('workspace settings for Codex', () => {
  it('stops a job whose workspace has Codex settings that could change its hooks', () => {
    const ws = join(dir, 'codex-ws');
    mkdirSync(join(ws, '.codex'), { recursive: true });
    expect(codexOverride(ws)).toBeNull();
    writeFileSync(join(ws, '.codex', 'config.toml'), 'model = "x"\n');
    expect(codexOverride(ws)).toBeNull();
    writeFileSync(join(ws, '.codex', 'config.toml'), '[features]\nhooks = false\n');
    expect(codexOverride(join(ws, 'sub'))).toBe(join(ws, '.codex', 'config.toml'));
    expect(() => codex.start({ cwd: ws, env: {}, command: 'codex', model: 'm', systemPrompt: '', prompt: '' }, () => undefined)).toThrow(
      /did not start/,
    );
  });
});

describe.skipIf(process.platform === 'win32')('the core socket', () => {
  it('answers the API on the Unix socket sandboxed jobs use', async () => {
    const { ctx, close } = await serve({ dataDir: join(dir, 'data'), port: 0, embedded: true });
    try {
      const status = await new Promise<number>((resolve, reject) =>
        request({ socketPath: ctx.paths.socket, path: '/api/health' }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
          .on('error', reject)
          .end(),
      );
      expect(status).toBe(200);
    } finally {
      await close();
      delete process.env.YAHO_DATA_DIR;
    }
  });
});
