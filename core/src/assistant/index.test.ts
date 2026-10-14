import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { getAgent, sendMessage } from '../store.ts';
import { tools } from './index.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
const call = (name: string, args: Record<string, unknown>) => Promise.resolve().then(() => tools(ctx)[name]!.run(args, {}));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-chat-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  ctx.settings.defaults.budget_usd = 5;
  await call('save_agent', { yaml: 'name: scout\nbudget_usd: 2\nguardrails: {rate_per_hour: 4, command_rules: [{pattern: "rm *", action: ask}]}' });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('what the chat leaves to the human', () => {
  it('lowers a budget and tightens guardrails, but does not raise or loosen them', async () => {
    await call('save_agent', { yaml: 'name: scout\nbudget_usd: 1' });
    expect(getAgent(ctx, 'scout').budget_usd).toBe(1);
    await expect(call('save_agent', { yaml: 'name: scout\nbudget_usd: 50' })).rejects.toThrow(/raise a budget/);
    const g = (rules: string, rate = 4) => ({ yaml: `name: scout\nguardrails: {rate_per_hour: ${rate}, command_rules: [${rules}]}` });
    await call('save_agent', g('{pattern: "rm *", action: ask}, {pattern: "curl *", action: block}', 2));
    await expect(call('save_agent', g('{pattern: "rm *", action: ask}, {pattern: "curl *", action: block}', 9))).rejects.toThrow(/rate_per_hour/);
    await expect(call('save_agent', g('{pattern: "curl *", action: block}', 2))).rejects.toThrow(/removed/);
    await expect(
      call('save_agent', g('{pattern: "rm *", action: ask}, {pattern: "curl *", action: block}, {pattern: "*", action: allow}', 2)),
    ).rejects.toThrow(/allow rule/);
    expect(getAgent(ctx, 'scout').guardrails.command_rules).toHaveLength(2);
  });

  it('keeps spend caps and default guardrails to Settings', async () => {
    const cap = ctx.settings.global_spend_cap_usd;
    await expect(call('update_settings', { yaml: `global_spend_cap_usd: ${cap * 10}` })).rejects.toThrow(/global spend cap/);
    await expect(call('update_settings', { yaml: 'defaults: {budget_usd: 500}' })).rejects.toThrow(/default budget/);
    await expect(call('update_settings', { yaml: 'defaults: {guardrails: {command_rules: [{pattern: "*", action: allow}]}}' })).rejects.toThrow(
      /default guardrails/,
    );
    await call('update_settings', { yaml: `global_spend_cap_usd: ${cap / 2}` });
    expect(ctx.settings.global_spend_cap_usd).toBe(cap / 2);
  });

  it('does not answer a request to run a command', async () => {
    const q = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'question', title: 't', body: 'b', choices: ['Allow once', 'Always allow', 'Deny'] });
    ctx.db
      .prepare("INSERT INTO command_approvals (id, agent, job, session, command, message, created) VALUES ('apv1','scout','j',NULL,'rm x',?,?)")
      .run(q.id, new Date().toISOString());
    await expect(call('message_agent', { to: 'scout', body: 'Always allow', reply_to: q.id })).rejects.toThrow(/inbox/);
    expect(ctx.db.prepare("SELECT status FROM command_approvals WHERE id = 'apv1'").get()).toEqual({ status: 'pending' });
  });
});
