import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { platform } from '../lib/platform.ts';
import { cn } from './ui/cn.ts';

/** Copies text and says so for a moment. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors [&_svg]:size-3.5',
        done ? 'border-accent bg-accent text-white' : 'border-line bg-panel text-ink hover:bg-hover',
      )}
    >
      {done ? <Check /> : <Copy />} {done ? 'Copied' : label}
    </button>
  );
}

/** The text of a fenced block, and its language and label (```copy Connection note). */
function fence(node: unknown): { lang: string; label: string; text: string } {
  const code = (node as { children?: Array<{ properties?: { className?: string[] }; data?: { meta?: string }; children?: Array<{ value?: string }> }> })
    .children?.[0];
  const lang = (code?.properties?.className ?? []).find((c) => c.startsWith('language-'))?.slice(9) ?? '';
  const text = (code?.children ?? []).map((c) => c.value ?? '').join('').replace(/\n$/, '');
  return { lang, label: code?.data?.meta?.trim() ?? '', text };
}

/** Agents write Markdown; render it like Claude does. Links open in the default browser. Raw HTML is not rendered. */
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) platform.openExternal(href);
      }}
      className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
    >
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mt-4 mb-2 font-serif text-lg first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 font-serif text-base first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-muted">{children}</blockquote>,
  hr: () => <hr className="my-4 border-line" />,
  // ```copy [label]: text the human pastes somewhere (a note, an email). Shown as text with a Copy button.
  // Other fenced blocks are code, with a Copy button in the corner.
  pre: ({ node, children }) => {
    const f = fence(node);
    if (f.lang === 'copy')
      return (
        <div className="my-2 rounded-lg border border-line bg-code">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">{f.label || 'Text to copy'}</span>
            <CopyButton text={f.text} />
          </div>
          <div className="px-3 py-2.5 whitespace-pre-wrap">{f.text}</div>
        </div>
      );
    return (
      <div className="group relative my-2">
        <pre className="overflow-x-auto rounded-lg bg-code p-3 text-[12.5px]">{children}</pre>
        <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={f.text} />
        </div>
      </div>
    );
  },
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-code px-1 py-0.5 text-[0.9em]">{children}</code>
    ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">{children}</th>,
  td: ({ children }) => <td className="border-b border-line px-2 py-1 align-top">{children}</td>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('leading-relaxed break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
