import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import type { Settings } from '../settings/types.ts';
import { DOT, PostChoice, SUMMARY, useAction, type SlackStatus } from './shared.tsx';

/**
 * Your Yaho inbox as Slack DMs. Setup: create the app from Yaho's manifest, install it, paste its two tokens, then
 * send the one-time link code from Slack so Yaho knows it is you. Tokens are saved with Save Settings, which reconnects.
 */
export function SlackSettings({
  value,
  stored,
  onChange,
}: {
  value: NonNullable<Settings['slack']>;
  stored: Record<string, boolean>;
  onChange: (v: NonNullable<Settings['slack']>) => void;
}) {
  const status = useApi<SlackStatus>('/api/slack', (e) => e.type === 'changed' && (e.entity === 'slack' || e.entity === 'settings'));
  const st = status.data;
  const [actionError, post] = useAction();
  const set = (patch: Partial<NonNullable<Settings['slack']>>) => onChange({ ...value, ...patch });
  const { line, state: tone } = SUMMARY.slack(st ?? undefined);
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => post('/api/slack/reconnect', status.reload)}>
            Reconnect
          </Button>
        )}
      </div>
      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      <ol className="space-y-3 text-sm">
        {(
          [
            [
              'Create the app',
              <>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" onClick={() => st && platform.openExternal(st.create_url)}>
                    Open Slack
                  </Button>
                  <Button size="sm" onClick={() => st && void navigator.clipboard.writeText(st.manifest)}>
                    Copy Manifest
                  </Button>
                </div>
                <p className="mt-1.5 text-muted">
                  In Slack choose <b className="text-ink">Create New App → From a Manifest</b>, pick your workspace, switch to JSON, paste
                  the manifest over what is there, and click <b className="text-ink">Create</b>.
                </p>
              </>,
            ],
            [
              'Install it and copy the Bot Token',
              <p className="mt-0.5 text-muted">
                In the app's left menu open <b className="text-ink">OAuth &amp; Permissions</b>, click{' '}
                <b className="text-ink">Install to Workspace</b> and allow it. Copy the <b className="text-ink">Bot User OAuth Token</b>{' '}
                (starts with <code>xoxb-</code>) into Bot Token below.
              </p>,
            ],
            [
              'Make the App Token',
              <p className="mt-0.5 text-muted">
                Open <b className="text-ink">Basic Information</b>, scroll to <b className="text-ink">App-Level Tokens</b>, click{' '}
                <b className="text-ink">Generate Token and Scopes</b>, name it Yaho, add the scope <code>connections:write</code>, and
                generate. Copy the token (starts with <code>xapp-</code>) into App Token below. The other secrets on that page are not
                needed.
              </p>,
            ],
            [
              'Save and link your Slack user',
              <>
                <p className="mt-0.5 text-muted">
                  Click <b className="text-ink">Save Settings</b>. Once connected, send this command in Slack (or the code alone as a DM to
                  Yaho): only the person who sends it can use Yaho, and Yaho DMs you that it is connected.
                </p>
                {st?.link_code && !st.owner && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <code className="rounded bg-hover px-2 py-1 text-xs select-all">/yaho link {st.link_code}</code>
                    <Button size="sm" onClick={() => void navigator.clipboard.writeText(`/yaho link ${st.link_code}`)}>
                      Copy Command
                    </Button>
                  </div>
                )}
              </>,
            ],
          ] as const
        ).map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
              {i + 1}
            </span>
            <div className="min-w-0">
              <div className="font-medium">{title}</div>
              {body}
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Bot Token" hint="OAuth & Permissions → Bot User OAuth Token (xoxb-…).">
          <Input
            type="password"
            value={value.bot_token ?? ''}
            placeholder={stored['slack.bot_token'] ? 'Value set · type to replace' : 'xoxb-…'}
            onChange={(e) => set({ bot_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="App Token" hint="Basic Information → App-Level Tokens (xapp-…).">
          <Input
            type="password"
            value={value.app_token ?? ''}
            placeholder={stored['slack.app_token'] ? 'Value set · type to replace' : 'xapp-…'}
            onChange={(e) => set({ app_token: e.target.value.trim() || undefined })}
          />
        </Field>
      </div>
      <PostChoice label="Post to Slack" value={value.post} onChange={(post) => set({ post })} />
      {st?.owner && (
        <p className="text-xs text-muted">
          Linked to one Slack user.{' '}
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => post('/api/slack/forget-owner', status.reload)}
          >
            Forget it
          </button>{' '}
          to link another Slack user with a new code.
        </p>
      )}
    </Card>
  );
}
