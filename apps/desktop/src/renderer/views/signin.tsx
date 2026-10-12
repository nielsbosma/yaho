import { ArrowRight, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Wordmark } from '../components/Wordmark.tsx';
import { Button } from '../components/ui/button.tsx';
import { ErrorNote } from '../components/ui/display.tsx';
import { Input } from '../components/ui/form.tsx';

/** The server version's sign-in: the password set as YAHO_PASSWORD when the server was deployed. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-4">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-6 shadow-sm">
        <Wordmark className="h-8" />
        <div>
          <h1 className="font-serif text-2xl">Sign In</h1>
          <p className="mt-1 text-sm text-muted">The password is the one set as YAHO_PASSWORD when this server was deployed.</p>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Input type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" variant="primary" className="w-full" disabled={!password || busy}>
          {busy ? <Loader2 className="animate-spin" /> : null} Sign In <ArrowRight />
        </Button>
      </form>
    </div>
  );
}
