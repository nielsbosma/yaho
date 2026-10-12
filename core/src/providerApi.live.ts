// A live check of every provider with the keys in .plan/secrets.env (not part of the test suite: it spends a little).
//   node --experimental-strip-types core/src/providerApi.live.ts
import { readFileSync } from 'node:fs';
import type { ProviderConfig, Settings } from './config.ts';
import { chatRound, jobAccess, listModels, priceFor } from './providerApi.ts';

const env = Object.fromEntries(
  readFileSync(new URL('../../.plan/secrets.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const providers: Array<[ProviderConfig, string]> = [
  [{ id: 'litellm', kind: 'litellm', url: env.LITELLM_URL!.replace(/\/$/, ''), api_key: env.LITELLM_API_KEY }, 'claude-haiku-5-5'],
  [{ id: 'anthropic', kind: 'anthropic', api_key: env.ANTHROPIC_API_KEY }, 'claude-haiku-5-5'],
  [{ id: 'openrouter', kind: 'openrouter', api_key: env.OPENROUTER_API_KEY }, 'anthropic/claude-haiku-5.5'],
  [{ id: 'opper', kind: 'opper', api_key: env.OPPER_API_KEY }, 'anthropic/claude-haiku-4-5'],
  [{ id: 'berget', kind: 'berget', api_key: env.BERGET_API_KEY }, 'mistralai/Mistral-Small-3.2-24B-Instruct-2506'],
  [{ id: 'openai', kind: 'openai', api_key: env.OPENAI_API_KEY }, 'gpt-5-mini'],
];
const s = { providers: providers.map(([p]) => p) } as unknown as Settings;
const tools = [{ type: 'function' as const, function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

for (const [p, model] of providers) {
  const line: string[] = [p.id.padEnd(10)];
  try {
    line.push(`${(await listModels(s, p)).length} models`);
  } catch (e) {
    line.push(`models: ${(e as Error).message.slice(0, 80)}`);
  }
  try {
    const messages: Parameters<typeof chatRound>[1]['messages'] = [{ role: 'user', content: 'What is the weather in Stockholm? Use the tool, then answer in five words.' }];
    const first = await chatRound(p, { model, messages, tools, max_tokens: 300 });
    const call = first.message.tool_calls?.[0];
    line.push(call ? `tool ${call.function.name}(${call.function.arguments})` : `no tool call (${first.finish_reason})`);
    if (call) {
      messages.push(first.message, { role: 'tool', tool_call_id: call.id, content: '{"temperature_c": 12, "sky": "cloudy"}' });
      const second = await chatRound(p, { model, messages, tools, max_tokens: 300 });
      line.push(`then: "${String(second.message.content).replace(/\s+/g, ' ').slice(0, 60)}"`);
    }
  } catch (e) {
    line.push(`chat: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  try {
    const a = await jobAccess(s, p, { models: [model], remaining: 1, agent: 'x', job: 'x' });
    line.push(`jobs: ${a.budget}, ${Object.keys(a.env).join('+')}`);
  } catch (e) {
    line.push(`jobs: ${(e as Error).message.slice(0, 60)}`);
  }
  const price = await priceFor(s, p, model).catch(() => null);
  line.push(price ? `$${(price.input * 1e6).toFixed(2)}/$${(price.output * 1e6).toFixed(2)} per M` : 'no price');
  console.log(line.join(' | '));
}
