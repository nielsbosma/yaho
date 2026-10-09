import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from './ui/cn.ts';

/** A panel width the person can drag, remembered on this device. */
export function usePanelWidth(key: string, initial: number, min: number, max: number): [number, (w: number) => void] {
  const storageKey = `yaho-width-${key}`;
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(storageKey));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (w: number) => {
      const clamped = Math.round(Math.min(max, Math.max(min, w)));
      setWidth(clamped);
      try {
        localStorage.setItem(storageKey, String(clamped));
      } catch {
        /* this session only */
      }
    },
    [storageKey, min, max],
  );
  return [width, set];
}

/**
 * A drag handle on a panel's edge. `side` is where the handle sits on the panel it resizes: 'right' for a panel on
 * the left (dragging right widens it), 'left' for a panel on the right. Double-click restores the default width.
 */
export function Resizer({
  width,
  onChange,
  side,
  initial,
}: {
  width: number;
  onChange: (w: number) => void;
  side: 'left' | 'right';
  initial: number;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      if (!start.current) return;
      const dx = e.clientX - start.current.x;
      onChange(start.current.w + (side === 'right' ? dx : -dx));
    };
    const up = () => {
      start.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, onChange, side]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = { x: e.clientX, w: width };
        setDragging(true);
      }}
      onDoubleClick={() => onChange(initial)}
      className={cn('group absolute top-0 z-30 h-full w-2 cursor-col-resize', side === 'right' ? '-right-1' : '-left-1')}
    >
      <div className={cn('mx-auto h-full w-px transition-colors group-hover:bg-accent/60', dragging && 'bg-accent')} />
    </div>
  );
}
