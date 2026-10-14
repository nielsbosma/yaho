import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Dialog } from '../../components/ui/dialog.tsx';
import { api } from '../../lib/api.ts';
import { go } from '../../lib/router.ts';

export function DeleteAgent({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        <Trash2 /> Delete
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${name}?`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/agents/${name}`, { method: 'DELETE' });
                go('agents');
              }}
            >
              Delete Agent
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Running jobs are stopped, and the agent's jobs, sessions and briefing history are removed. Its workspace folder stays on disk.
        </p>
      </Dialog>
    </>
  );
}
