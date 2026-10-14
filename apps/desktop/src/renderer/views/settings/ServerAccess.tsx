import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Card, ErrorNote, Section } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { api } from '../../lib/api.ts';

/** Server version: sign out, end every session, and the API token for the CLI and scripts (after the password and code). */
export function ServerAccess() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/session')
      .then((r) => r.json())
      .then((s: { totp?: boolean }) => setTotp(!!s.totp))
      .catch((e) => setError(`Could not read the session: ${(e as Error).message}`));
  }, []);
  const signOut = async (everywhere: boolean) => {
    setError(null);
    try {
      if (everywhere) await api('/api/session/revoke-all', { method: 'POST' });
      await fetch('/api/session', { method: 'DELETE' });
      location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Section title="Server Access">
      <Card className="space-y-4 p-4">
        <p className="text-sm text-muted">
          The password is YAHO_PASSWORD in this server's deploy settings. Change it there and redeploy; that also signs everyone out.
          {totp
            ? ' To move the authenticator to a new phone, set YAHO_TOTP_RESET=1 there and redeploy, sign in with the password and scan the new QR code, then remove YAHO_TOTP_RESET.'
            : ' To also ask for a code from an authenticator app, set YAHO_TOTP=1 there and redeploy.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut(false)}>Sign Out</Button>
          <Button onClick={() => void signOut(true)}>Sign Out Everywhere</Button>
        </div>
        <Field label="API Token" hint={`For the yaho CLI and scripts. Enter the password${totp ? ' and a code' : ''} to show it.`}>
          {token ? (
            <code className="block rounded-lg bg-code px-3 py-2 text-xs break-all select-all">{token}</code>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  setToken((await api<{ token: string }>('/api/session/token', { body: { password, code } })).token);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <div className="flex-1">
                <Input type="password" value={password} placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
              </div>
              {totp && (
                <div className="w-32">
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    placeholder="Code"
                    onChange={(e) => setCode(e.target.value)}
                  />
                </div>
              )}
              <Button type="submit" disabled={!password || (totp && !code.trim())}>
                Show Token
              </Button>
            </form>
          )}
        </Field>
        <ErrorNote>{error}</ErrorNote>
      </Card>
    </Section>
  );
}
