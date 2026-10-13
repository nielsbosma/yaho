import { expect, test } from 'vite-plus/test';
import { defaultModel } from './defaultModel.ts';

test('the newest Claude Sonnet, by any provider prefix', () => {
  expect(defaultModel(['claude-opus-5', 'claude-sonnet-4-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5-20260101'])).toBe('claude-sonnet-5-5');
  expect(defaultModel(['anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-3.7-sonnet'])).toBe('anthropic/claude-sonnet-4.5');
});

test('else the newest plain GPT', () => {
  expect(defaultModel(['gpt-3.5-turbo', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.5-pro', 'gpt-5.5-2026-04-23', 'gpt-4o'])).toBe('gpt-5.5');
});

test('else the first model', () => {
  expect(defaultModel(['Qwen/Qwen3.6-27B', 'moonshotai/Kimi-K3'])).toBe('Qwen/Qwen3.6-27B');
  expect(defaultModel([])).toBe('');
});
