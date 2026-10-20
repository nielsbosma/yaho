import { describe, expect, it } from 'vite-plus/test';
import { fixTables } from './tables.ts';

describe('fixTables', () => {
  it('adds the missing line under a header', () => {
    expect(fixTables('Yesterday:\n| Metric | Oct 17 | Oct 10 |\n| Users | 22,561 | 1,438 |\n\nAfter')).toBe(
      'Yesterday:\n\n| Metric | Oct 17 | Oct 10 |\n| --- | --- | --- |\n| Users | 22,561 | 1,438 |\n\nAfter',
    );
  });

  it('takes rows without outer pipes', () => {
    expect(
      fixTables('Yesterday vs a week earlier:\nMetric | Oct 19 | Oct 12\nActive users | 4,292 | 1,694\nSessions | 4,374 | 1,795'),
    ).toBe(
      'Yesterday vs a week earlier:\n\nMetric | Oct 19 | Oct 12\n| --- | --- | --- |\nActive users | 4,292 | 1,694\nSessions | 4,374 | 1,795',
    );
  });

  it('leaves prose with a stray pipe alone', () => {
    const md = 'Search: a | b\nNext line with c | d | e\n- list | item\n- list | item';
    expect(fixTables(md)).toBe(md);
  });

  it('leaves proper tables, single lines and code alone', () => {
    const md = '| A | B |\n|---|--:|\n| x | 1 |\n| y | 2 |\n| z | 3 |\n\n| just | one |\n\n```\n| a |\n| b |\n```';
    expect(fixTables(md)).toBe(md);
  });
});
