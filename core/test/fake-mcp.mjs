// A small MCP server for tests, over stdio or (with --http <port>) Streamable HTTP that wants "Bearer let-me-in".
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

function build() {
  const server = new Server(
    { name: 'fake-mcp', version: '1.2.3' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: 'A test server.' },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo the text back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'add',
        description: 'Add two numbers',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      },
      { name: 'whoami', description: 'The FAKE_SECRET it was started with', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = req.params.arguments ?? {};
    if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${a.text}` }] };
    if (req.params.name === 'add') return { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] };
    if (req.params.name === 'whoami')
      return { content: [{ type: 'text', text: `secret=${process.env.FAKE_SECRET ?? ''} cwd=${process.cwd()}` }] };
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'demo://note', name: 'note', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: 'a note from the server' }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${req.params.arguments?.who}` } }],
  }));
  return server;
}

const i = process.argv.indexOf('--http');
if (i < 0) {
  process.stderr.write('fake-mcp ready\n');
  await build().connect(new StdioServerTransport());
} else {
  createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer let-me-in') return void res.writeHead(401).end('{"error":"unauthorized"}');
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const s = build();
    res.on('close', () => void t.close().then(() => s.close()));
    await s.connect(t);
    let body = '';
    for await (const c of req) body += c;
    await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }).listen(Number(process.argv[i + 1]), '127.0.0.1', () => process.stdout.write('listening\n'));
}
