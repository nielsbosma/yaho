import { ArrowRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { renderSVG } from 'uqr';
import { Wordmark } from '../components/Wordmark.tsx';
import { Button } from '../components/ui/button.tsx';
import { ErrorNote } from '../components/ui/display.tsx';
import { Input } from '../components/ui/form.tsx';

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
}

function Panel({ title, onSubmit, children }: { title: string; onSubmit: () => Promise<void>; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-6 shadow-sm"
      >
        <Wordmark className="h-8" />
        <h1 className="font-serif text-2xl">{title}</h1>
        {children}
      </form>
    </div>
  );
}

const CodeInput = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <Input
    inputMode="numeric"
    autoComplete="one-time-code"
    placeholder="6-digit code"
    maxLength={7}
    value={value}
    onChange={(e) => onChange(e.target.value.replace(/[^0-9 ]/g, ''))}
  />
);

/**
 * The server version's sign-in: the password set as YAHO_PASSWORD when the server was deployed, and the code from the
 * authenticator app once one is set up.
 */
export function SignIn({ totp, onSignedIn }: { totp: boolean; onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/session', { password, code });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Sign In" onSubmit={submit}>
      <ErrorNote>{error}</ErrorNote>
      <Input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {totp && <CodeInput value={code} onChange={setCode} />}
      <Button type="submit" variant="primary" className="w-full" disabled={!password || (totp && !code.trim()) || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null} Sign In <ArrowRight />
      </Button>
      <div className="text-center text-xs">
        {lost ? (
          <p className="text-muted">
            The password is YAHO_PASSWORD in this server's deploy settings. Change it there and redeploy to set a new one.
            {totp && ' Lost your phone? Set YAHO_TOTP_RESET=1 there and redeploy, sign in with the password and set up the authenticator again, then remove YAHO_TOTP_RESET.'}
          </p>
        ) : (
          <button type="button" onClick={() => setLost(true)} className="cursor-pointer text-muted hover:text-ink hover:underline">
            {totp ? 'Lost Your Password or Phone?' : 'Lost Your Password?'}
          </button>
        )}
      </div>
    </Panel>
  );
}

/** After the first password sign-in: scan the QR code with an authenticator app and confirm with a code from it. */
export function TotpSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/session/totp')
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
        return r.json();
      })
      .then(setSetup)
      .catch((err: Error) => setError(err.message));
  }, []);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/session/totp', { code });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Set Up Two-Factor" onSubmit={submit}>
      <p className="text-sm text-muted">
        Scan this with Google Authenticator or another authenticator app, then enter the code it shows. From now on, signing in asks for the password and a code.
      </p>
      <ErrorNote>{error}</ErrorNote>
      {setup && (
        <>
          <div className="mx-auto w-48 rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: renderSVG(setup.uri, { border: 1 }) }} />
          <p className="text-center text-xs text-muted">
            Or enter this key: <code className="select-all">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          </p>
          <p className="text-xs text-muted">Keep a copy of the key, for example in a password manager, so a lost phone does not lock you out.</p>
        </>
      )}
      <CodeInput value={code} onChange={setCode} />
      <Button type="submit" variant="primary" className="w-full" disabled={!setup || !code.trim() || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null} Confirm <ArrowRight />
      </Button>
    </Panel>
  );
}
