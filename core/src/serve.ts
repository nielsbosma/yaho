import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Router } from './api/http.ts';
import { agentRoutes } from './api/agentRoutes.ts';
import { composioRoutes } from './api/composioRoutes.ts';
import { mcpRoutes } from './api/mcpRoutes.ts';
import { fontRoutes } from './api/fonts.ts';
import { exampleRoutes, humanRoutes, yahoVersion } from './api/routes.ts';
import { startServer } from './api/server.ts';
import { apiToken, loadSettings, paths, privateDir, saveSettings, writePrivate } from './config.ts';
import { Bus, type Ctx } from './context.ts';
import { openDb } from './db/index.ts';
import { indexMissing } from './history.ts';
import { JobRunner } from './jobs/runner.ts';
import { Scheduler } from './scheduler/index.ts';
import { SlackBridge } from './slack/bridge.ts';
import { WhatsAppBridge } from './whatsapp/bridge.ts';
import { EmailBridge } from './email/resend.ts';
import { SmsBridge } from './sms/twilio.ts';
import { BrowserManager } from './browser/index.ts';
import { TelegramBridge } from './telegram/bridge.ts';
import { LocalDopbase } from './secrets/localDopbase.ts';
import { loadSecrets } from './secrets/settingsSecrets.ts';
import { Updates } from './updates.ts';
import { McpHub } from './mcp/hub.ts';
import { SANDBOX_GUARD, sandboxGuardScript } from './harness/sandbox.ts';
import { COMMAND_GUARD, commandGuardScript } from './harness/commandGuard.ts';
import { checkServerPassword, loadTotp, serverMode } from './api/session.ts';

// node:sqlite prints an ExperimentalWarning on Node 22; it is expected.
process.removeAllListeners('warning');

/** Build the core and start serving. Used by `yaho serve` and by the desktop app. */
export async function serve(
  opts: { host?: string; port?: number; dataDir?: string; webRoot?: string; embedded?: boolean } = {},
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  if (opts.dataDir) process.env.YAHO_DATA_DIR = opts.dataDir;
  const p = paths();
  privateDir(p.root);
  checkServerPassword();
  const settings = loadSettings();
  const ctx: Ctx = { db: openDb(p.db), settings, paths: p, apiToken: apiToken(), bus: new Bus(), apiUrl: '' };
  loadTotp(ctx);

  const runner = new JobRunner(ctx);
  runner.recover();
  indexMissing(ctx);
  // The bundled Dopbase runs next to the core whatever the mode, so switching to it in Settings needs no restart.
  ctx.localDopbase = new LocalDopbase(ctx);
  if (ctx.settings.dopbase.mode === 'bundled' && !process.env.YAHO_NO_DOPBASE) await ctx.localDopbase.start();
  // Keys and tokens live in Dopbase; read them in (and move any still in settings.yaml) before anything uses them.
  await loadSecrets(ctx);
  // An install from before the first-run setup existed, with agents already: it is set up.
  if (!ctx.settings.onboarded_at && ctx.db.prepare('SELECT 1 FROM agents LIMIT 1').get()) {
    ctx.settings.onboarded_at = new Date().toISOString();
    saveSettings(ctx.settings);
  }
  const scheduler = new Scheduler(ctx);
  ctx.scheduler = scheduler;
  ctx.slack = new SlackBridge(ctx);
  ctx.whatsapp = new WhatsAppBridge(ctx);
  ctx.email = new EmailBridge(ctx);
  ctx.sms = new SmsBridge(ctx);
  ctx.browser = new BrowserManager(ctx);
  ctx.telegram = new TelegramBridge(ctx);
  ctx.mcp = new McpHub(ctx);

  const router = new Router();
  humanRoutes(ctx, router);
  agentRoutes(ctx, router);
  exampleRoutes(ctx, router);
  fontRoutes(router);
  composioRoutes(ctx, router);
  mcpRoutes(ctx, router);
  writeShims(ctx);

  // In a container the port must be reachable from outside it; the password guards it.
  const host = opts.host ?? (serverMode() ? '0.0.0.0' : settings.server.host);
  const port = opts.port ?? Number(process.env.YAHO_PORT ?? settings.server.port);
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = opts.webRoot ?? process.env.YAHO_WEB_ROOT ?? join(here, '../../apps/desktop/dist/renderer');
  const server = await startServer(ctx, router, { host, port, webRoot, socket: process.platform === 'win32' ? undefined : p.socket });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  ctx.apiUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  writePrivate(p.server, YAML.stringify({ url: ctx.apiUrl, pid: process.pid, started: new Date().toISOString() }));

  // The integrations connect in the background; a bad token shows in Settings, never blocks the core.
  if (!opts.embedded) void ctx.slack.start();
  // WhatsApp, Email and SMS need webhooks from the internet, so they only run in the server version.
  if (!opts.embedded && serverMode()) void ctx.whatsapp.start();
  if (!opts.embedded && serverMode()) void ctx.email.start();
  if (!opts.embedded && serverMode()) void ctx.sms.start();
  if (!opts.embedded) void ctx.telegram.start();
  ctx.updates = new Updates(ctx, yahoVersion());
  if (!opts.embedded) ctx.updates.start();

  const close = async () => {
    scheduler.stop();
    await ctx.slack?.stop();
    ctx.whatsapp?.stop();
    ctx.email?.stop();
    ctx.sms?.stop();
    ctx.telegram?.stop();
    ctx.updates?.stop();
    await ctx.mcp?.closeAll();
    ctx.localDopbase?.stop();
    await runner.shutdown();
    await ctx.browser?.closeAll();
    rmSync(p.server, { force: true });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    ctx.db.close();
  };
  if (!opts.embedded) {
    const exit = () => void close().finally(() => process.exit(0));
    process.once('SIGINT', exit);
    process.once('SIGTERM', exit);
    // The desktop app holds stdin open; when it goes away, so do we.
    if (process.env.YAHO_EXIT_WITH_PARENT) process.stdin.on('end', exit).resume();
    console.log(`yaho core listening on ${ctx.apiUrl} (data: ${p.root})`);
  }

  runner.pump();
  scheduler.start(Number(process.env.YAHO_TICK_MS ?? 5000));
  return { ctx, close };
}

/**
 * Put `yaho` on every harness's PATH: a .cmd for Windows programs and an extensionless sh script for Git Bash
 * (Claude Code's Bash tool on Windows), both running the CLI with the same Node (or Electron-as-Node) as the core.
 */
function writeShims(ctx: Ctx): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const cli = process.env.YAHO_CLI_MAIN ?? join(here, '../../cli/src/main.ts');
  const node = process.execPath;
  const electron = !!process.versions.electron;
  const flags = cli.endsWith('.ts') ? '--experimental-strip-types --no-warnings' : '--no-warnings';
  // Agents run these, so only the core may change them: the folder and files are its own, readable by everyone.
  mkdirSync(ctx.paths.bin, { recursive: true });
  chmodSync(ctx.paths.bin, 0o755);
  // A fresh file each time: never write through whatever stands at the name now.
  const put = (name: string, data: string, mode: number) => {
    const file = join(ctx.paths.bin, name);
    rmSync(file, { force: true });
    writeFileSync(file, data, { mode, flag: 'wx' });
    chmodSync(file, mode);
  };
  const cmd = ['@echo off', ...(electron ? ['set ELECTRON_RUN_AS_NODE=1'] : []), `"${node}" ${flags} "${cli}" %*`];
  put('yaho.cmd', cmd.join('\r\n') + '\r\n', 0o644);
  const posix = (p: string) => p.replaceAll('\\', '/');
  const sh = ['#!/bin/sh', `${electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec "${posix(node)}" ${flags} "${posix(cli)}" "$@"`];
  put('yaho', sh.join('\n') + '\n', 0o755);
  ctx.cli = { command: node, args: [...flags.split(' '), cli], env: electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
  put(SANDBOX_GUARD, sandboxGuardScript(), 0o644);
  put(COMMAND_GUARD, commandGuardScript(), 0o644);
}
