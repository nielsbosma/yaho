import { describe, expect, it } from 'vite-plus/test';
import { plainText } from './plainText.ts';

describe('plainText', () => {
  it('strips Markdown for one-line previews', () => {
    const md = '**1. OTel-Native by Design** (34 pts, 4 comments)\nArticle: [the post](https://example.com) and `code`, _emphasis_';
    expect(plainText(md)).toBe('1. OTel-Native by Design (34 pts, 4 comments) Article: the post and code, emphasis');
  });

  it('drops headings, quotes, list markers and code blocks', () => {
    expect(plainText('# Title\n> quoted\n- one\n2. two\n```js\nx()\n```\ndone')).toBe('Title quoted one two done');
  });

  it('leaves ordinary text alone', () => {
    expect(plainText('snake_case and 2*3 stay')).toBe('snake_case and 2*3 stay');
  });
});
