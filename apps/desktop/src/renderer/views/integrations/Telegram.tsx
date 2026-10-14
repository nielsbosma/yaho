import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Card } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { useApi } from '../../lib/api.ts';
import { platform } from '../../lib/platform.ts';
import type { Settings } from '../settings/types.ts';
import { PostChoice, StatusLine, Steps, SUMMARY, useAction, type TelegramStatus } from './shared.tsx';

/**
 * Your Yaho inbox in a chat with your own Telegram bot. Yaho fetches the bot's updates itself (long polling), so it
 * works on the desktop too. Opening the bot's one-time link tells Yaho which chat is yours.
 */
export function TelegramSettings({
  value,
  stored,
  onChange,
}: {
  value: NonNullable<Settings['telegram']>;
  stored: Record<string, boolean>;
  onChange: (v: NonNullable<Settings['telegram']>) => void;
}) {
  const status = useApi<TelegramStatus>(
    '/api/telegram',
    (e) => e.type === 'changed' && (e.entity === 'telegram' || e.entity === 'settings'),
  );
  const st = status.data;
  const [actionError, post] = useAction();
  const set = (patch: Partial<NonNullable<Settings['telegram']>>) => onChange({ ...value, ...patch });
  const { line, state } = SUMMARY.telegram(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Create a bot with BotFather',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://t.me/BotFather')}>
            Open BotFather
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Send <code>/newbot</code>, give it a name and a username ending in <code>bot</code>. BotFather answers with the bot's token: paste
          it below as Bot Token and click <b className="text-ink">Save Settings</b>.
        </p>
      </>,
    ],
    [
      'Open your bot',
      <>
        <div className="mt-1.5">
          <Button size="sm" disabled={!st?.link_url} onClick={() => st?.link_url && platform.openExternal(st.link_url)}>
            Open in Telegram
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          The link carries a one-time code: press <b className="text-ink">Start</b> in Telegram and Yaho answers that it is connected. Only
          that chat can use the bot.
        </p>
      </>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <StatusLine
        state={state}
        line={line}
        action={
          st?.configured && (
            <Button size="sm" onClick={() => post('/api/telegram/reconnect', status.reload)}>
              Reconnect
            </Button>
          )
        }
      />
      {actionError && <p className="text-xs text-danger">{actionError}</p>}
      <Steps steps={steps} />
      <Field label="Bot Token" hint="From BotFather, like 123456789:AA…">
        <Input
          type="password"
          value={value.bot_token ?? ''}
          placeholder={stored['telegram.bot_token'] ? 'Value set · type to replace' : '123456789:AA…'}
          onChange={(e) => set({ bot_token: e.target.value.trim() || undefined })}
        />
      </Field>
      <PostChoice label="Post to Telegram" value={value.post} onChange={(post) => set({ post })} />
      {st?.linked && (
        <p className="text-xs text-muted">
          Linked to one Telegram chat.{' '}
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => post('/api/telegram/forget-owner', status.reload)}
          >
            Forget it
          </button>{' '}
          to make a new link.
        </p>
      )}
    </Card>
  );
}
