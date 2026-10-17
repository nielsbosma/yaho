import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field } from '../../components/ui/form.tsx';
import { platform } from '../../lib/platform.ts';

function Copyable({ label, hint, value }: { label: string; hint?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-start gap-2">
        <code className="block flex-1 rounded-lg bg-code px-3 py-2 text-xs break-all whitespace-pre-wrap select-all">{value}</code>
        <Button
          size="sm"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Field>
  );
}

/** Yaho's own MCP server: how to add it to Claude Code, Codex or any other MCP client. */
export function McpServer({ server }: { server: boolean }) {
  const url = new URL('/mcp', platform.apiUrl || location.origin).toString();
  return (
    <Section title="MCP Server">
      <Card className="space-y-4 p-4">
        <p className="text-sm text-muted">
          Other agents can use Yaho through its MCP server: read the inbox, run and change agents, and everything else Yaho's chat can do,
          with the same limits.{' '}
          {server
            ? 'The first time, the agent opens this site in your browser, where you sign in and press Allow.'
            : 'Programs on this computer need no sign-in, as long as Yaho is running.'}
        </p>
        <Copyable label="Server URL" value={url} />
        <Copyable label="Claude Code" value={`claude mcp add --transport http yaho ${url}`} />
        <Copyable
          label="Other Clients"
          hint="For clients that take an mcpServers JSON, such as Cursor or Claude Desktop."
          value={JSON.stringify({ mcpServers: { yaho: { type: 'http', url } } }, null, 2)}
        />
      </Card>
    </Section>
  );
}
