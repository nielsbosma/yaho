import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Router } from './api/http.ts';
import { agentRoutes } from './api/agentRoutes.ts';
import { exampleRoutes, humanRoutes } from './api/routes.ts';
import { startServer } from './api/server.ts';
import { apiToken, loadSettings, paths } from './config.ts';
import { Bus, type Ctx } from './context.ts';
import { openDb } from './db/index.ts';
import { JobRunner } from './jobs/runner.ts';
import { Scheduler } from './scheduler/index.ts';

// node:sqlite prints an ExperimentalWarning on Node 22; it is expected.
process.removeAllListeners('warning');

/** Build the core and start serving. Used by `yaho serve` and by the desktop app. */
export async function serve(
  opts: { host?: string; port?: number; dataDir?: string; webRoot?: string; embedded?: boolean } = {},
): Promise<{ ctx: Ctx; close: () => Promise<void> }> {
  if (opts.dataDir) process.env.YAHO_DATA_DIR = opts.dataDir;
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  const settings = loadSettings();
  const ctx: Ctx = { db: openDb(p.db), settings, paths: p, apiToken: apiToken(), bus: new Bus(), apiUrl: '' };

  const runner = new JobRunner(ctx);
  runner.recover();
  const scheduler = new Scheduler(ctx);
  ctx.scheduler = scheduler;

  const router = new Router();
  humanRoutes(ctx, router);
  agentRoutes(ctx, router);
  exampleRoutes(ctx, router);
  writeShims(ctx);

  const host = opts.host ?? settings.server.host;
  const port = opts.port ?? Number(process.env.YAHO_PORT ?? settings.server.port);
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = opts.webRoot ?? process.env.YAHO_WEB_ROOT ?? join(here, '../../apps/desktop/dist/renderer');
  const server = await startServer(ctx, router, { host, port, webRoot });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  ctx.apiUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  writeFileSync(p.server, YAML.stringify({ url: ctx.apiUrl, pid: process.pid, started: new Date().toISOString() }));

  const close = async () => {
    scheduler.stop();
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
