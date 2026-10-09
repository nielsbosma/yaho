import { cn } from './ui/cn.ts';

/** The yaho wordmark (assets/logo/wordmark.svg). Letters follow the text colour; the o is the accent loop. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 146 56" role="img" aria-label="Yaho" className={cn('h-6 w-auto', className)}>
      <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 19 L20 35 M32 19 L14 49" />
        <circle cx="53" cy="30" r="10.5" />
        <path d="M63.5 19 V41" />
        <path d="M78 6 V41 M78 29 a10 10 0 0 1 20 0 V41" />
      </g>
      <circle cx="120" cy="30" r="11" fill="none" stroke="var(--c-accent)" strokeWidth="7" />
      <circle cx="130.5" cy="18.5" r="4.5" fill="var(--c-accent-hover)" />
    </svg>
  );
}
