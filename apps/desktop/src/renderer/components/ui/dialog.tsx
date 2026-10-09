import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { Button } from './button.tsx';

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-panel shadow-xl"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="font-serif text-xl text-ink">{title}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="overflow-auto px-5 py-2">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 pt-2 pb-4">{footer}</div>}
      </div>
    </div>
  );
}
