import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from './ui/cn.ts';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/** A right-click menu: `open(event, items)` shows it at the pointer; Escape, scrolling or a click elsewhere closes it. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    // Keep it on screen near the right and bottom edges.
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - items.length * 36 - 16),
      items,
    });
  };

  const element = menu ? (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-line bg-panel py-1 shadow-xl"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            setMenu(null);
            item.onSelect();
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm [&_svg]:size-4',
            item.danger ? 'text-danger hover:bg-danger/10' : 'hover:bg-hover',
          )}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  ) : null;

  return { open, element };
}
