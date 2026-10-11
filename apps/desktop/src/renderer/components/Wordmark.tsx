import { cn } from './ui/cn.ts';

/**
 * The yaho wordmark (assets/logo/wordmark.svg). Letters follow the text colour; the o is an open loop in the accent
 * that fades behind its leading end: an agent at work.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 146 56" role="img" aria-label="Yaho" className={cn('h-6 w-auto', className)}>
      <g fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 19 L20 35 M32 19 L14 49" />
        <circle cx="53" cy="30" r="10.5" />
        <path d="M63.5 19 V41" />
        <path d="M78 6 V41 M78 29 a10 10 0 0 1 20 0 V41" />
      </g>
      <g fill="none" stroke="var(--c-accent)" strokeWidth="7">
        <path d="M130.34 26.24 A11 11 0 0 1 109.66 33.76" />
        <path d="M109.66 33.76 A11 11 0 0 1 111.57 22.93" opacity="0.55" />
        <path d="M111.57 22.93 A11 11 0 0 1 121.91 19.17" opacity="0.22" />
      </g>
      {/* The leading end, rounded. */}
      <circle cx="130.34" cy="26.24" r="3.5" fill="var(--c-accent)" />
    </svg>
  );
}
