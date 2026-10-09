import { ExternalLink, LayoutGrid, List, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { go } from '../lib/router.ts';
import { useContextMenu, type MenuItem } from './ContextMenu.tsx';
import { cn } from './ui/cn.ts';
import { Card } from './ui/display.tsx';

export type Layout = 'table' | 'cards';

/** Table or cards, remembered per list on this device. Tables are the default. */
export function useLayout(list: string): [Layout, (l: Layout) => void] {
  const key = `yaho-layout-${list}`;
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return localStorage.getItem(key) === 'cards' ? 'cards' : 'table';
    } catch {
      return 'table';
    }
  });
  return [
    layout,
    (l) => {
      try {
        localStorage.setItem(key, l);
      } catch {
        /* this session only */
      }
      setLayout(l);
    },
  ];
}

export function LayoutSwitch({ value, onChange }: { value: Layout; onChange: (l: Layout) => void }) {
  return (
    <div className="flex rounded-lg bg-hover p-0.5" role="radiogroup" aria-label="Layout">
      {(
        [
          ['table', List, 'Table'],
          ['cards', LayoutGrid, 'Cards'],
        ] as const
      ).map(([l, Icon, label]) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={value === l}
          title={label}
          onClick={() => onChange(l)}
          className={cn('cursor-pointer rounded-md p-1.5 text-muted', value === l && 'bg-panel text-ink shadow-sm')}
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  label: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

/** A clickable table: each row opens its item. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  to,
  menu,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  to: (r: T) => string[];
  /** Items for the row's right-click menu. */
  menu?: (r: T) => MenuItem[];
}) {
  const context = useContextMenu();
  return (
    <Card className="overflow-x-auto">
      {context.element}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            {columns.map((c) => (
              <th key={c.label} className={cn('px-4 py-2 font-medium', c.className)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={() => go(...to(r))}
              onContextMenu={menu ? (e) => context.open(e, menu(r)) : undefined}
              className="cursor-pointer border-b border-line last:border-0 hover:bg-hover/50"
            >
              {columns.map((c) => (
                <td key={c.label} className={cn('px-4 py-2.5 align-top', c.className)}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** The usual row menu: open it, or delete it (after a confirmation). */
export const openDeleteMenu = (open: () => void, remove: () => void): MenuItem[] => [
  { label: 'Open', icon: <ExternalLink />, onSelect: open },
  { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: remove },
];
