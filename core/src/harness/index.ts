import { claudeCode } from './claudeCode.ts';
import { codex } from './codex.ts';
import type { HarnessAdapter } from './types.ts';

/** The harnesses Yaho can run agents in. */
export const adapters: Record<string, HarnessAdapter> = { 'claude-code': claudeCode, codex };
export { killTree } from './claudeCode.ts';
