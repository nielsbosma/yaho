import { describe, expect, it } from 'vite-plus/test';
import { fixTables } from './tables.ts';

describe('fixTables', () => {
  it('adds the missing line under a header', () => {
    expect(fixTables('Yesterday:\n| Metric | Oct 17 | Oct 10 |\n| Users | 22,561 | 1,438 |\n\nAfter')).toBe(
      'Yesterday:\n\n| Metric | Oct 17 | Oct 10 |\n| --- | --- | --- |\n| Users | 22,561 | 1,438 |\n\nAfter',
    );
  });

  it('leaves proper tables, single lines and code alone', () => {
    const md = '| A | B |\n|---|--:|\n| x | 1 |\n\n| just | one |\n\n```\n| a |\n| b |\n```';
    expect(fixTables(md)).toBe(md);
  });
});
