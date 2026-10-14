// Runs inside a fake job: starts the MCP server named in the harness's --mcp-config (the yaho one) and uses it.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cfg = JSON.parse(readFileSync(process.env.FAKE_MCP_CONFIG, 'utf8')).mcpServers.yaho;
const client = new Client({ name: 'probe', version: '1' });
await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { PATH: process.env.PATH, ...cfg.env } }));
const { tools } = await client.listTools();
const r = await client.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] ?? '{}') });
process.stdout.write(JSON.stringify({ tools: tools.map((t) => t.name), result: r }) + '\n');
await client.close();
