import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from './cn.ts';

const field =
  'w-full rounded-lg border border-line bg-panel px-3 text-sm text-ink placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50 disabled:opacity-60';

/** Single-line inputs hold names, keys, URLs and tokens: no spell check, and Grammarly stays out. */
const plain = { spellCheck: false, autoCorrect: 'off', autoCapitalize: 'off', 'data-gramm': 'false', 'data-gramm_editor': 'false', 'data-enable-grammarly': 'false' } as const;

/** A text input. A password input gets an eye button that shows or hides what was typed. */
export function Input({ className, type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  if (type !== 'password') return <input type={type} className={cn(field, 'h-9', className)} {...plain} {...props} />;
  return (
    <div className="relative">
      <input type={shown ? 'text' : 'password'} className={cn(field, 'h-9 pr-9', className)} {...plain} {...props} />
      <button
        type="button"
        title={shown ? 'Hide' : 'Show'}
        aria-label={shown ? 'Hide' : 'Show'}
        onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-muted hover:text-ink [&_svg]:size-4"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'min-h-24 py-2 leading-relaxed', className)} {...props} />;
}

/** A labelled control. `group` renders a plain container, for compound controls a <label> would hijack clicks in. */
export function Field({
  label,
  hint,
  children,
  className,
  group,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  group?: boolean;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={cn('flex flex-col gap-1.5', className)} {...(group ? { role: 'group', 'aria-label': label } : {})}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </Tag>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/** A comma-separated list edited as text. */
export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <Input
      defaultValue={value.join(', ')}
      placeholder={placeholder}
      onBlur={(e) =>
        onChange(
          e.target.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

/** A native select styled like Input: own chevron, room for it, no browser arrow. */
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select className={cn(field, 'h-9 w-full cursor-pointer appearance-none pr-9')} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
    </div>
  );
}
