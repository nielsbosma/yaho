import type { McpConfig } from './config.ts';

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  homepage: string;
  config: McpConfig;
  /** Keys the person fills in when adding it; servers without keys sign in with OAuth or need nothing. */
  keys: Array<{ name: string; label: string; secret?: boolean }>;
  /** The server signs in with OAuth (Sign In on the resource after adding it). */
  oauth?: boolean;
}

/** Well-known MCP servers to start from; each one is an ordinary MCP resource once added. */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'github',
    title: 'GitHub',
    description: 'Repositories, issues, pull requests and Actions through GitHub’s own MCP server.',
    homepage: 'https://github.com/github/github-mcp-server',
    config: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
    keys: [{ name: 'GITHUB_TOKEN', label: 'A GitHub personal access token', secret: true }],
  },
  {
    id: 'linear',
    title: 'Linear',
    description: 'Issues, projects and comments in Linear.',
    homepage: 'https://linear.app/docs/mcp',
    config: { transport: 'http', url: 'https://mcp.linear.app/mcp' },
    keys: [],
    oauth: true,
  },
  {
    id: 'notion',
    title: 'Notion',
    description: 'Search, read and edit pages and databases in Notion.',
    homepage: 'https://developers.notion.com/docs/mcp',
    config: { transport: 'http', url: 'https://mcp.notion.com/mcp' },
    keys: [],
    oauth: true,
  },
  {
    id: 'sentry',
    title: 'Sentry',
    description: 'Errors, issues and releases in Sentry.',
    homepage: 'https://docs.sentry.io/product/sentry-mcp/',
    config: { transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
    keys: [],
    oauth: true,
  },
  {
    id: 'stripe',
    title: 'Stripe',
    description: 'Customers, payments, invoices and products in Stripe.',
    homepage: 'https://docs.stripe.com/mcp',
    config: { transport: 'http', url: 'https://mcp.stripe.com', headers: { Authorization: 'Bearer ${STRIPE_SECRET_KEY}' } },
    keys: [{ name: 'STRIPE_SECRET_KEY', label: 'A Stripe secret or restricted key', secret: true }],
  },
  {
    id: 'huggingface',
    title: 'Hugging Face',
    description: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.',
    homepage: 'https://huggingface.co/settings/mcp',
    config: { transport: 'http', url: 'https://huggingface.co/mcp', headers: { Authorization: 'Bearer ${HF_TOKEN}' } },
    keys: [{ name: 'HF_TOKEN', label: 'A Hugging Face access token', secret: true }],
  },
  {
    id: 'context7',
    title: 'Context7',
    description: 'Current documentation and code examples for libraries and frameworks.',
    homepage: 'https://github.com/upstash/context7',
    config: { transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } },
    keys: [{ name: 'CONTEXT7_API_KEY', label: 'A Context7 API key', secret: true }],
  },
  {
    id: 'playwright',
    title: 'Playwright',
    description: 'A real browser the agent drives: open pages, click, type, take screenshots.',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    config: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'] },
    keys: [],
  },
  {
    id: 'brave-search',
    title: 'Brave Search',
    description: 'Web, news, image and local search through the Brave Search API.',
    homepage: 'https://github.com/brave/brave-search-mcp-server',
    config: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    },
    keys: [{ name: 'BRAVE_API_KEY', label: 'A Brave Search API key', secret: true }],
  },
  {
    id: 'fetch',
    title: 'Fetch',
    description: 'Fetch a web page and turn it into Markdown.',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    config: { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    keys: [],
  },
];
