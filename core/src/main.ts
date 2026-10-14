#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serve } from './serve.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { host: { type: 'string' }, port: { type: 'string' }, 'data-dir': { type: 'string' }, 'web-root': { type: 'string' } },
});
const cmd = positionals[0] ?? 'serve';
if (cmd !== 'serve') {
  console.error(`unknown command ${cmd}; usage: serve [--host H] [--port P] [--data-dir D] [--web-root W]`);
  process.exit(2);
}
// A stray error in a listener or a promise should not take every running job down with the core: log it and carry on,
// unless they keep coming (then something is wrong for good, and a restart is the better state).
const recent: number[] = [];
process.on('unhandledRejection', (e) => console.error('[yaho] unhandled rejection:', e));
process.on('uncaughtException', (e) => {
  console.error('[yaho] uncaught exception:', e);
  const t = Date.now();
  recent.push(t);
  while (recent[0]! < t - 60_000) recent.shift();
  if (recent.length > 10) process.exit(1);
});
serve({
  host: values.host,
  port: values.port ? Number(values.port) : undefined,
  dataDir: values['data-dir'],
  webRoot: values['web-root'],
}).catch((e) => {
  // A start-up refusal (no YAHO_PASSWORD on a server) reads best as one line.
  console.error(e instanceof Error ? `yaho: ${e.message}` : e);
  process.exit(1);
});
