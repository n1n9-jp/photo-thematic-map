import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVER_VALUES, fillCoverTokens } from '../../src/story/content/cover';
import { FACTS } from '../../src/story/content/facts';

const indexHtml = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

describe('表紙の数値', () => {
  it('facts.ts の値から組み立てる', () => {
    expect(COVER_VALUES.totalParked).toBe('1万3,394台');
    expect(COVER_VALUES.removedFY2024).toBe('18万7,262台');
    expect(COVER_VALUES.reportYear).toBe('令和7年度');
    expect(FACTS.totalParked.value).toBe(13_394);
  });

  it('index.html の表紙の数値はすべて埋まり、題名・リード文は静的に書いてある', () => {
    const html = fillCoverTokens(indexHtml);
    expect(html).not.toMatch(/\{\{ptm:[A-Za-z0-9]+\}\}/);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('東京の放置自転車</h1>');
    expect(html).toContain(`<span class="ptm-cover__num">${COVER_VALUES.totalParked}</span>`);
    expect(html).toContain(`<span class="ptm-cover__num">${COVER_VALUES.removedFY2024}</span>`);
    expect(html).toContain('非公式の作品');
  });

  it('知らないキーはビルドを止める', () => {
    expect(() => fillCoverTokens('{{ptm:unknownKey}}')).toThrow(/unknownKey/);
  });
});
