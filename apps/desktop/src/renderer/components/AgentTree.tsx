import { Bot, ChevronRight, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { api, useApi, type Agent } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { useAgentMenu } from './AgentMenu.tsx';
import { useContextMenu } from './ContextMenu.tsx';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';
import { Dialog } from './ui/dialog.tsx';
import { ErrorNote } from './ui/display.tsx';
import { Field, Input } from './ui/form.tsx';

const DRAG = 'application/x-yaho-agent';
const COLLAPSED = 'yaho:collapsed-folders';

function loadCollapsed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * The sidebar's agent list. Folders are optional: agents in a folder are listed under it, the rest below the
 * folders. Drag an agent onto a folder to move it in, or onto the Agents heading or the free space to take it out.
 */
export function AgentTree({ agents, active }: { agents: Agent[] | null | undefined; active: string | null }) {
  const folders = useApi<string[]>('/api/folders', (e) => e.type === 'changed' && e.entity === 'agents');
  const agentMenu = useAgentMenu();
  const folderMenu = useContextMenu();
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const [over, setOver] = useState<string | null>(null); // folder name, or '' for the top level
  const [naming, setNaming] = useState<{ folder?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const toggle = (f: string) => {
    const next = collapsed.includes(f) ? collapsed.filter((x) => x !== f) : [...collapsed, f];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED, JSON.stringify(next));
    } catch {
      /* the folder just opens again next time */
    }
  };

  const move = async (agent: string, folder: string | null) => {
    setError(null);
    try {
      await api(`/api/agents/${encodeURIComponent(agent)}/folder`, { method: 'PUT', body: { folder } });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Drop targets: a folder name, or '' for the top level.
  const drop = (target: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setOver(target);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o === target ? null : o));
    },
    onDrop: (e: DragEvent) => {
      const agent = e.dataTransfer.getData(DRAG);
      if (!agent) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      const a = agents?.find((x) => x.name === agent);
      if ((a?.folder ?? '') !== target) void move(agent, target || null);
    },
  });

  const folderNames = folders.data ?? [];
  const known = new Set(folderNames);
  const loose = agents?.filter((a) => !a.folder || !known.has(a.folder)) ?? [];

  const row = (a: Agent, nested: boolean) => (
    <a
      key={a.name}
      href={href('agents', a.name)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, a.name);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setOver(null)}
      onContextMenu={(e) => agentMenu.open(e, a)}
      className={cn(
        'flex h-8 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
        nested && 'pl-7',
        active === a.name ? 'bg-hover font-medium' : 'hover:bg-hover/70',
        !a.enabled && 'text-muted',
      )}
    >
      <Bot className={cn('size-4 shrink-0', a.running ? 'text-info' : 'text-muted')} />
      <span className="truncate">{a.name}</span>
      {a.running ? <span className="ml-auto size-1.5 animate-pulse rounded-full bg-info" /> : null}
    </a>
  );

  return (
    <>
      <div
        {...drop('')}
        className={cn('mx-2 mt-5 flex items-center justify-between rounded-md px-2 pb-1', over === '' && 'bg-accent/10 ring-1 ring-accent/40')}
      >
        <a href={href('agents')} className="text-xs font-semibold tracking-wide text-muted uppercase hover:text-ink">
          Agents
        </a>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            title="New Folder"
            onClick={() => setNaming({})}
            className="cursor-pointer rounded p-0.5 text-muted hover:bg-hover hover:text-ink"
          >
            <FolderPlus className="size-3.5" />
          </button>
          <a href={href('agents', 'new')} title="New Agent" className="rounded p-0.5 text-muted hover:bg-hover hover:text-ink">
            <Plus className="size-3.5" />
          </a>
        </span>
      </div>
      <div {...drop('')} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <ErrorNote>{error}</ErrorNote>
        {folderNames.map((f) => {
          const inside = agents?.filter((a) => a.folder === f) ?? [];
          const open = !collapsed.includes(f);
          const running = inside.some((a) => a.running);
          return (
            <div key={f} {...drop(f)} className={cn('flex flex-col gap-0.5 rounded-lg', over === f && 'bg-accent/10 ring-1 ring-accent/40')}>
              <button
                type="button"
                onClick={() => toggle(f)}
                onContextMenu={(e) =>
                  folderMenu.open(e, [
                    { label: 'Rename', icon: <Pencil />, onSelect: () => setNaming({ folder: f }) },
                    {
                      label: 'Delete Folder',
                      icon: <Trash2 />,
                      danger: true,
                      onSelect: () => setDeleting(f),
                    },
                  ])
                }
                title={inside.length ? undefined : 'Empty: drag agents here'}
                className="flex h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm text-ink/85 hover:bg-hover/70"
              >
                <ChevronRight className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
                <span className="truncate">{f}</span>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted tabular-nums">
                  {!open && running && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
                  {inside.length}
                </span>
              </button>
              {open && inside.map((a) => row(a, true))}
            </div>
          );
        })}
        {loose.map((a) => row(a, false))}
        {agents?.length === 0 && <div className="px-2.5 py-1 text-xs text-muted">No agents yet</div>}
        {/* Free space below the list is a drop target for the top level too. */}
        <div className="min-h-6 flex-1" />
      </div>
      {agentMenu.element}
      {folderMenu.element}
      {naming && <FolderDialog folder={naming.folder} onClose={() => setNaming(null)} />}
      {deleting && (
        <DeleteFolderDialog folder={deleting} agents={agents?.filter((a) => a.folder === deleting).map((a) => a.name) ?? []} onClose={() => setDeleting(null)} />
      )}
    </>
  );
}

function FolderDialog({ folder, onClose }: { folder?: string; onClose: () => void }) {
  const [name, setName] = useState(folder ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const next = name.trim();
    if (!next || next === folder) return onClose();
    try {
      if (folder) await api(`/api/folders/${encodeURIComponent(folder)}`, { method: 'PUT', body: { name: next } });
      else await api('/api/folders', { body: { name: next } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={folder ? `Rename ${folder}` : 'New Folder'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save()}>
            {folder ? 'Rename' : 'Create Folder'}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <ErrorNote>{error}</ErrorNote>
        <Field label="Name" hint={folder ? undefined : 'Then drag agents onto it in the sidebar.'}>
          <Input
            autoFocus
            value={name}
            placeholder="Marketing"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Delete a folder; its agents move to the top level unless "Delete all agents" is ticked. */
function DeleteFolderDialog({ folder, agents, onClose }: { folder: string; agents: string[]; onClose: () => void }) {
  const [withAgents, setWithAgents] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    try {
      await api(`/api/folders/${encodeURIComponent(folder)}${withAgents ? '?agents=1' : ''}`, { method: 'DELETE' });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${folder}?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()}>
            {withAgents ? `Delete Folder and ${agents.length} Agent${agents.length === 1 ? '' : 's'}` : 'Delete Folder'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <ErrorNote>{error}</ErrorNote>
        {agents.length ? (
          <>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--c-danger)]" checked={withAgents} onChange={(e) => setWithAgents(e.target.checked)} />
              <span>
                Delete all agents
                <span className="block text-xs text-muted">{agents.join(', ')}</span>
              </span>
            </label>
            <p className="text-muted">
              {withAgents
                ? "The agents' jobs, sessions and briefing history are removed, and running jobs are stopped. Their workspace folders stay on disk."
                : 'The agents stay, ungrouped at the top level.'}
            </p>
          </>
        ) : (
          <p className="text-muted">The folder is empty.</p>
        )}
      </div>
    </Dialog>
  );
}
