import { Pencil, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, type Agent, type Job } from '../lib/api.ts';
import { go } from '../lib/router.ts';
import { useConfirmDelete } from './ConfirmDelete.tsx';
import { useContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Button } from './ui/button.tsx';
import { Dialog } from './ui/dialog.tsx';
import { ErrorNote } from './ui/display.tsx';
import { Field, Input, Textarea } from './ui/form.tsx';

/** Run Now, with optional instructions for this run. Agents without a schedule usually need them. */
export function RunDialog({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDemand = !agent.triggers.some((t) => 'cron' in t);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await api<Job>(`/api/agents/${agent.name}/run`, { body: { message: text } });
      setText('');
      onClose();
      go('jobs', job.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Run ${agent.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run()} title="Run (Ctrl+Enter)">
            <Play /> Run
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <ErrorNote>{error}</ErrorNote>
        <Field
          label="What should it do this time?"
          hint="Sent to the agent's inbox as instructions for this run. Leave empty to just run its briefing."
        >
          <Textarea
            autoFocus
            className="min-h-32"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
            }}
            placeholder={onDemand ? 'e.g. Make a 1200x630 social card for the 3.0 launch' : 'Optional'}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Rename an agent: its jobs, messages and workspace folder move with it. */
function RenameDialog({ agent, onClose }: { agent: string | null; onClose: () => void }) {
  return agent ? <RenameForm key={agent} agent={agent} onClose={onClose} /> : null;
}

function RenameForm({ agent, onClose }: { agent: string; onClose: () => void }) {
  const [name, setName] = useState(agent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name.trim();
    if (!next || next === agent) return onClose();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agents/${encodeURIComponent(agent)}`, { method: 'PUT', body: { name: next } });
      onClose();
      // Follow the agent if its page is open.
      const route = location.hash.replace(/^#\//, '').split('/').map(decodeURIComponent);
      if (route[0] === 'agents' && route[1] === agent) go('agents', next, ...route.slice(2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rename ${agent}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Rename
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Name" hint="Lowercase letters, digits and dashes. Messages and the workspace folder move with it.">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** The agent right-click menu (Run, Rename, Delete) with its dialogs. Render `element` once; `items(agent)` builds the menu. */
export function useAgentMenu() {
  const menu = useContextMenu();
  const [running, setRunning] = useState<Agent | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const del = useConfirmDelete(
    'Agent',
    (name) => api(`/api/agents/${name}`, { method: 'DELETE' }),
    "Running jobs are stopped, and the agent's jobs, sessions and briefing history are removed. Its workspace folder stays on disk.",
  );
  const items = (a: Agent): MenuItem[] => [
    ...(a.enabled ? [{ label: 'Run', icon: <Play />, onSelect: () => setRunning(a) }] : []),
    { label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(a.name) },
    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => del.ask(a.name) },
  ];
  const element = (
    <>
      {menu.element}
      {del.dialog}
      {running && <RunDialog agent={running} open onClose={() => setRunning(null)} />}
      <RenameDialog agent={renaming} onClose={() => setRenaming(null)} />
    </>
  );
  return { open: (e: React.MouseEvent, a: Agent) => menu.open(e, items(a)), items, element };
}
