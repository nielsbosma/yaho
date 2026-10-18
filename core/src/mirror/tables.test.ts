import { describe, expect, it } from 'vite-plus/test';
import { toTelegram } from '../telegram/format.ts';
import { plainTables } from './tables.ts';

describe('plainTables', () => {
  it('turns a Markdown table into an aligned grid', () => {
    expect(
      plainTables(
        'Before\n\n| Metric | Oct 8 | Oct 15 |\n|---|--:|--:|\n| **Sessions** | 2162 | 16014 |\n| Views | 2710 | 16859 |\n\nAfter',
      ),
    ).toBe(
      'Before\n\n```\nMetric    Oct 8  Oct 15\n--------  -----  ------\nSessions   2162   16014\nViews      2710   16859\n```\n\nAfter',
    );
  });

  it('turns a chart into its title and a grid of its numbers', () => {
    const md = '```chart\ntype: bar\ntitle: Sessions\nunit: "%"\nx: [Oct 8, Oct 15]\nseries:\n  Engagement: [21, 3.5]\n```';
    expect(plainTables(md)).toBe('**Sessions**\n```\n        Engagement\n------  ----------\nOct 8          21%\nOct 15        3.5%\n```');
  });

  it('takes a table written without its rule line', () => {
    expect(plainTables('| Metric | Oct 17 |\n| Users | 22,561 |')).toBe('```\nMetric  Oct 17\n------  ------\nUsers   22,561\n```');
  });

  it('leaves other fences and a broken chart alone', () => {
    const md = '```ts\nconst a = 1 | 2;\n```\n```chart\nnot: [valid\n```';
    expect(plainTables(md)).toBe(md);
  });

  it('feeds the chat formats', () => {
    expect(toTelegram('| A | B |\n|---|---|\n| x | 1 |')).toBe('<pre>A  B\n-  -\nx  1</pre>');
  });
});
