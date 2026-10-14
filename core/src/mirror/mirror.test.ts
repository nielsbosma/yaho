import { describe, expect, it } from 'vite-plus/test';
import type { ChatMessage } from '../assistant/index.ts';
import { lastAnswer, trimHistory } from './index.ts';
import { emailAllowed, phoneAllowed, RateLimit, serial, splitText } from './util.ts';

describe('trimHistory', () => {
  const call = { id: 'c1', type: 'function' as const, function: { name: 'list_agents', arguments: '{}' } };
  const turn = (n: number): ChatMessage[] => [
    { role: 'user', content: `q${n}` },
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', content: '[]', tool_call_id: 'c1' },
    { role: 'assistant', content: `a${n}` },
  ];

  it('keeps only the words of the person and Yaho, starting with the person', () => {
    const all = [{ role: 'system' as const, content: 'sys' }, ...turn(1), ...turn(2), { role: 'user' as const, content: [{ type: 'text', text: 'x' }] as never }];
    expect(trimHistory(all)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    // A cut that would start with Yaho's answer drops it.
    expect(trimHistory([...turn(1), ...turn(2)], 3)).toEqual([
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(trimHistory(turn(1).slice(1))).toEqual([]);
    expect(lastAnswer(turn(3))).toBe('a3');
  });
});

describe('inbound limits', () => {
  it('counts hits in a sliding window', () => {
    const r = new RateLimit(2, 1000);
    expect([r.take('a', 0), r.take('a', 10), r.take('a', 20), r.take('b', 20)]).toEqual([true, true, false, true]);
    expect(r.take('a', 1005)).toBe(true);
  });

  it('matches allowlists of addresses, domains and phones', () => {
    expect(emailAllowed(undefined, 'x@y.com')).toBe(true);
    expect(emailAllowed('anna@corp.se, @partner.io', 'Anna@corp.se')).toBe(true);
    expect(emailAllowed('anna@corp.se, @partner.io', 'bo@corp.se')).toBe(false);
    expect(emailAllowed(['partner.io'], 'bo@partner.io')).toBe(true);
    expect(emailAllowed(['partner.io'], 'bo@evilpartner.io')).toBe(false);
    expect(phoneAllowed('+46 70 123 45 67', '+46701234567')).toBe(true);
    expect(phoneAllowed('+46701234567', '+46709999999')).toBe(false);
  });

  it('runs calls with one key one at a time', async () => {
    const order: string[] = [];
    const job = (n: string, ms: number) => serial('k', async () => {
      order.push(`${n}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${n}-`);
    });
    await Promise.all([job('a', 20), job('b', 0), serial('k', async () => Promise.reject(new Error('x'))).catch(() => order.push('c!')), job('d', 0)]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-', 'c!', 'd+', 'd-']);
  });
});

describe('splitText', () => {
  it('cuts at breaks, or where adjust says', () => {
    expect(splitText('aaaa\n\nbbbb', 6)).toEqual(['aaaa', 'bbbb']);
    expect(splitText('abcdefghij', 4, (_t, at) => at - 1)).toEqual(['abc', 'def', 'ghij']);
  });
});
