import { Copy, Loader2, RotateCw, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { api, useApi } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { Button } from './ui/button.tsx';

interface UpdateState {
  current: string;
  latest?: string;
  available: boolean;
  mode: 'npm' | 'manual';
  command: string;
  notes_url?: string;
  status?: 'installing' | 'done' | 'failed';
  error?: string;
}

const dismissedKey = (v: string) => `yaho-update-dismissed-${v}`;
const isDismissed = (v: string) => {
  try {
    return localStorage.getItem(dismissedKey(v)) === '1';
  } catch {
    return false;
  }
};

/**
 * A strip across the top of the window when a newer Yaho is out: What's New, and Update Now, which installs it with
 * npm and then offers Restart. Without npm (dev session, installer builds) it shows the command to copy instead.
 * Dismissed, it stays away until the next version.
 */
export function UpdateBanner() {
  const u = useApi<UpdateState | null>('/api/update', (e) => e.type === 'changed' && e.entity === 'updates');
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = u.data;
  if (!s?.available || !s.latest || hidden || (isDismissed(s.latest) && !s.status)) return null;

  const install = async () => {
    setError(null);
    try {
      await api('/api/update/install', { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const text =
    s.status === 'installing'
      ? `Installing Yaho ${s.latest}…`
      : s.status === 'done'
        ? `Yaho ${s.latest} is installed. Restart to use it; running jobs pick up where they were.`
        : s.status === 'failed'
          ? `The update did not install. ${s.error ?? ''}`
          : `Yaho ${s.latest} is available. You have ${s.current}.`;

  return (
    <div
      role="status"
      className="titlebar-clear flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-accent/30 bg-accent/10 py-2 pl-4 text-sm"
    >
      <Sparkles className="size-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">{error ?? text}</span>
      {s.notes_url && s.status !== 'done' && (
        <button
          type="button"
          className="cursor-pointer text-accent underline-offset-2 hover:underline"
          onClick={() => platform.openExternal(s.notes_url!)}
        >
          What's New
        </button>
      )}
      {s.status === 'installing' && <Loader2 className="size-4 animate-spin text-muted" />}
      {s.status === 'done' && platform.restart && (
        <Button size="sm" variant="primary" onClick={() => platform.restart!()}>
          <RotateCw /> Restart Yaho
        </Button>
      )}
      {(!s.status || s.status === 'failed') && s.mode === 'npm' && (
        <Button size="sm" variant="primary" onClick={() => void install()}>
          {s.status === 'failed' ? 'Try Again' : 'Update Now'}
        </Button>
      )}
      {(s.mode === 'manual' || s.status === 'failed') && (
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(s.command);
            setCopied(true);
          }}
          title={s.command}
        >
          <Copy /> {copied ? 'Copied' : 'Copy Update Command'}
        </Button>
      )}
      {s.status !== 'installing' && (
        <button
          type="button"
          title="Not now"
          aria-label="Dismiss"
          className="cursor-pointer text-muted hover:text-ink"
          onClick={() => {
            try {
              localStorage.setItem(dismissedKey(s.latest!), '1');
            } catch {
              /* hide for this session only */
            }
            setHidden(true);
          }}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}
