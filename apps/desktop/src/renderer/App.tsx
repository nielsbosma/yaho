import { useEffect, useState } from 'react';
import { Assistant } from './components/Assistant.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { onLive, useApi } from './lib/api.ts';
import { platform } from './lib/platform.ts';
import { go, useRoute } from './lib/router.ts';
import { views } from './views/index.tsx';

export interface AppState {
  version: string;
  unread: number;
  running: number;
  queued: number;
  spent_usd: number;
  global_spend_cap_usd: number;
}

export function App() {
  const route = useRoute();
  const [connected, setConnected] = useState(true);
  // The chat starts closed on every launch; Ctrl+J or the sidebar button opens it.
  const [assistant, setAssistant] = useState(false);
  const toggleAssistant = (open = !assistant) => setAssistant(open);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setAssistant((a) => !a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // What the chat is about: a job to continue, or an agent to discuss (at most one).
  const [chatJob, setChatJob] = useState<string | null>(null);
  const [chatAgent, setChatAgent] = useState<string | null>(null);
  useEffect(() => {
    const onJob = (e: Event) => {
      setChatAgent(null);
      setChatJob((e as CustomEvent<string>).detail);
      toggleAssistant(true);
    };
    const onAgent = (e: Event) => {
      setChatJob(null);
      setChatAgent((e as CustomEvent<string>).detail);
      toggleAssistant(true);
    };
    window.addEventListener('yaho:chat-job', onJob);
    window.addEventListener('yaho:chat-agent', onAgent);
    return () => {
      window.removeEventListener('yaho:chat-job', onJob);
      window.removeEventListener('yaho:chat-agent', onAgent);
    };
  });
  const state = useApi<AppState>('/api/state', (e) => e.type === 'message' || e.type === 'job');

  useEffect(
    () =>
      onLive((e) => {
        if (e.type === 'connection') setConnected(e.connected);
        // The desktop shell raises native notifications itself; the web build does it here.
        if (e.type === 'notify' && platform.kind === 'web') platform.notify(e.title, e.body, () => e.message && go('inbox', e.message));
      }),
    [],
  );
  useEffect(() => {
    platform.setBadge(state.data?.unread ?? 0);
  }, [state.data?.unread]);

  if (!platform.token) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted">
        Open this page with <code className="mx-1">?token=…</code> (the token is in the data directory's{' '}
        <code className="mx-1">api-token</code> file).
      </div>
    );
  }

  const View = views[route[0] ?? 'inbox'] ?? views.inbox!;
  return (
    <div className="flex h-full">
      <Sidebar route={route} state={state.data} connected={connected} assistantOpen={assistant} onAssistant={() => toggleAssistant()} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <View route={route} />
      </main>
      {assistant && (
        <Assistant
          job={chatJob}
          agent={chatAgent}
          onLeaveJob={() => setChatJob(null)}
          onLeaveAgent={() => setChatAgent(null)}
          onClose={() => {
            toggleAssistant(false);
            setChatJob(null);
            setChatAgent(null);
          }}
        />
      )}
    </div>
  );
}
