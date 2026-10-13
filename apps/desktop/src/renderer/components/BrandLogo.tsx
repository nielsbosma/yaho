import anthropic from '../assets/providers/anthropic.svg';
import berget from '../assets/providers/berget.svg';
import claude from '../assets/providers/claude.svg';
import composio from '../assets/providers/composio.svg';
import litellm from '../assets/providers/litellm.svg';
import openai from '../assets/providers/openai.svg';
import openrouter from '../assets/providers/openrouter.svg';
import opper from '../assets/providers/opper.svg';
import resend from '../assets/providers/resend.svg';
import slack from '../assets/providers/slack.svg';
import whatsapp from '../assets/providers/whatsapp.svg';
import { cn } from './ui/cn.ts';

/**
 * The services Yaho connects to, with their own marks (assets/providers): Anthropic, OpenAI, OpenRouter, Resend and WhatsApp from Simple Icons,
 * Slack's colour mark, the rest from the companies' sites.
 */
export const BRAND_LOGOS = { anthropic, berget, claude, composio, litellm, openai, openrouter, opper, resend, slack, whatsapp } as const;
export type Brand = keyof typeof BRAND_LOGOS;

/** A brand's mark on a small white tile, so it reads the same in light and dark. */
export function BrandLogo({ brand, size = 'md', className }: { brand: string; size?: 'sm' | 'md'; className?: string }) {
  const src = (BRAND_LOGOS as Record<string, string>)[brand];
  if (!src) return null;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg border border-line bg-white',
        size === 'sm' ? 'size-5 rounded-md' : 'size-9',
        className,
      )}
    >
      <img src={src} alt="" className={cn('object-contain', size === 'sm' ? 'size-3.5' : 'size-5')} />
    </span>
  );
}
