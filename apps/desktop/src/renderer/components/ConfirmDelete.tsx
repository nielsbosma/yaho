import { useState } from 'react';
import { ErrorNote } from './ui/display.tsx';
import { Button } from './ui/button.tsx';
import { Dialog } from './ui/dialog.tsx';

/**
 * Ask before deleting something: `ask(name)` opens the dialog, and `remove(name)` runs only after Delete is pressed.
 * Render `dialog` once in the view.
 */
export function useConfirmDelete(noun: string, remove: (name: string) => Promise<unknown>, consequence: string) {
  const [target, setTarget] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setTarget(null);
    setError(null);
  };
  const dialog = (
    <Dialog
      open={!!target}
      onClose={close}
      title={`Delete ${label ?? target}?`}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await remove(target!);
                close();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete {noun}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <ErrorNote>{error}</ErrorNote>
        <p className="text-sm text-muted">{consequence}</p>
      </div>
    </Dialog>
  );
  /** `label` names it in the title when the key is not readable (an id). */
  const ask = (key: string, name?: string) => {
    setTarget(key);
    setLabel(name ?? null);
  };
  return { ask, dialog };
}
