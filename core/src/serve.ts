import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Router } from './api/http.ts';
import { agentRoutes } from './api/agentRoutes.ts';
import { composioRoutes } from './api/composioRoutes.ts';
import { fontRoutes } from './api/fonts.ts';
import { exampleRoutes, humanRoutes, yahoVersion } from './api/routes.ts';
import { startServer } from './api/server.ts';
import { apiToken, loadSettings, paths, saveSettings } from './config.ts';
import { Bus, type Ctx } from './context.ts';
import { openDb } from './db/index.ts';
import { JobRunner } from './jobs/runner.ts';
import { Scheduler } from './scheduler/index.ts';
import { SlackBridge } from './slack/bridge.ts';
import { WhatsAppBridge } from './whatsapp/bridge.ts';
import { LocalDopbase } from './secrets/localDopbase.ts';
import { loadSecrets } from './secrets/settingsSecrets.ts';
import { Updates } from './updates.ts';
import { checkServerPassword, loadTotp, serverMode } from './api/session.ts';

// node:sqlite prints an ExperimentalWarning on Node 22; it is expected.
process.removeAllListeners('warning');

/** Build the core and start serving. Used by `yaho serve` and by the desktop app. */
export async function serve(
  opts: { host?: string; port?: number; dataDir?: string; webRoot?: string; embedded?: boolean } = {},
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  if (opts.dataDir) process.env.YAHO_DATA_DIR = opts.dataDir;
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  checkServerPassword();
  const settings = loadSettings();
  const ctx: Ctx = { db: openDb(p.db), settings, paths: p, apiToken: apiToken(), bus: new Bus(), apiUrl: '' };
  loadTotp(ctx);

  const runner = new JobRunner(ctx);
  runner.recover();
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

  const router = new Router();
  humanRoutes(ctx, router);
  agentRoutes(ctx, router);
  exampleRoutes(ctx, router);
  fontRoutes(router);
  composioRoutes(ctx, router);
  writeShims(ctx);

  // In a container the port must be reachable from outside it; the password guards it.
  const host = opts.host ?? (serverMode() ? '0.0.0.0' : settings.server.host);
  const port = opts.port ?? Number(process.env.YAHO_PORT ?? settings.server.port);
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = opts.webRoot ?? process.env.YAHO_WEB_ROOT ?? join(here, '../../apps/desktop/dist/renderer');
  const server = await startServer(ctx, router, { host, port, webRoot });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  ctx.apiUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  writeFileSync(p.server, YAML.stringify({ url: ctx.apiUrl, pid: process.pid, started: new Date().toISOString() }));

  // Slack and WhatsApp connect in the background; a bad token shows in Settings, never blocks the core.
  if (!opts.embedded) void ctx.slack.start();
  if (!opts.embedded) void ctx.whatsapp.start();
  ctx.updates = new Updates(ctx, yahoVersion());
  if (!opts.embedded) ctx.updates.start();

  const close = async () => {
    scheduler.stop();
    await ctx.slack?.stop();
    ctx.whatsapp?.stop();
    ctx.updates?.stop();
    ctx.localDopbase?.stop();
    await runner.shutdown();
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
  mkdirSync(ctx.paths.bin, { recursive: true });
  const cmd = ['@echo off', ...(electron ? ['set ELECTRON_RUN_AS_NODE=1'] : []), `"${node}" ${flags} "${cli}" %*`];
  writeFileSync(join(ctx.paths.bin, 'yaho.cmd'), cmd.join('\r\n') + '\r\n');
  const posix = (p: string) => p.replaceAll('\\', '/');
  const sh = ['#!/bin/sh', `${electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec "${posix(node)}" ${flags} "${posix(cli)}" "$@"`];
  writeFileSync(join(ctx.paths.bin, 'yaho'), sh.join('\n') + '\n', { mode: 0o755 });
}
