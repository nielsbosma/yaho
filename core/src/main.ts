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
serve({
  host: values.host,
  port: values.port ? Number(values.port) : undefined,
  dataDir: values['data-dir'],
  webRoot: values['web-root'],
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
