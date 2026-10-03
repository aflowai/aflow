import { BROWSER_MIN_CHARS, BROWSER_OUTLINE_DEFAULT_CHARS } from '@aflow/schemas';

import { encodedLength } from '../browser/encodedLength.js';
import { describe, expect, it } from 'vitest';

import { buildOutline } from '../browser/outline.js';

const PAGE = [
  '- generic [ref=e1]:',
  '  - banner [ref=e2]:',
  '    - link "Home" [ref=e3] [cursor=pointer]:',
  '      - /url: https://example.com/',
  '    - navigation [ref=e4]:',
  '      - list [ref=e5]:',
  '        - listitem [ref=e6]:',
  '          - link "Docs" [ref=e7]:',
  '            - /url: /docs',
  '  - main [ref=e8]:',
  '    - heading "Example Domain" [level=1] [ref=e9]',
  '    - paragraph [ref=e10]: This domain is for use in illustrative examples.',
  '    - img "Diagram" [ref=e11]',
  '    - searchbox "Search" [ref=e12]',
  '    - checkbox "Remember me" [checked] [ref=e13]',
  '    - \'button "Save: now" [ref=e14]\'',
  '    - textbox "Password" [ref=e15]: correct-horse',
  '    - text: free-standing text',
].join('\n');

describe('the outline', () => {
  it('keeps interactive elements and headings, in document order, with their references', () => {
    const outline = buildOutline({ text: PAGE, maskedRefs: new Set(['e15']) });
    expect(outline.text.split('\n')).toEqual([
      '- link "Home" [ref=e3] [url=https://example.com/]',
      '- link "Docs" [ref=e7] [url=/docs]',
      '- heading "Example Domain" [level=1] [ref=e9]',
      '- searchbox "Search" [ref=e12]',
      '- checkbox "Remember me" [checked] [ref=e13]',
      '- button "Save: now" [ref=e14]',
      '- textbox "Password" [ref=e15]',
    ]);
    expect(outline.elements).toBe(7);
    expect(outline.census).toBeUndefined();
  });

  it('never carries the value of a password field', () => {
    const outline = buildOutline({ text: PAGE, maskedRefs: new Set(['e15']) });
    expect(outline.text).not.toContain('correct-horse');
  });

  it('is cut at the bound and ends with a census of what it left out, by role', () => {
    const lines = ['- main [ref=e0]:'];
    for (let i = 1; i <= 3000; i += 1) {
      lines.push(`  - link "Article number ${String(i)}" [ref=l${String(i)}]:`);
      lines.push(`    - /url: /articles/${String(i)}`);
      if (i % 10 === 0)
        lines.push(`  - heading "Section ${String(i)}" [level=2] [ref=h${String(i)}]`);
      if (i % 25 === 0) lines.push(`  - button "More ${String(i)}" [ref=b${String(i)}]`);
    }
    const outline = buildOutline({ text: lines.join('\n'), maskedRefs: new Set() });

    expect(encodedLength(outline.text)).toBeLessThanOrEqual(BROWSER_OUTLINE_DEFAULT_CHARS);
    expect(outline.census).toBeDefined();
    const census = outline.census ?? {};
    const shown = outline.text.split('\n').slice(0, -1);
    expect(shown.length).toBe(outline.elements);
    expect(outline.elements + Object.values(census).reduce((a, b) => a + b, 0)).toBe(
      3000 + 300 + 120,
    );
    expect(census['link']).toBeGreaterThan(0);
    expect(census['heading']).toBeGreaterThan(0);
    expect(census['button']).toBeGreaterThan(0);

    const last = outline.text.split('\n').at(-1) ?? '';
    expect(last).toMatch(
      /^# Outline cut at 7000 characters\. Not shown: link \d+, heading \d+, button \d+\. browser\.page\.snapshot with a `ref` shows one region whole, or raise `maxChars`\.$/,
    );
    // What was kept is the start of the page, in order.
    expect(shown[0]).toBe('- link "Article number 1" [ref=l1] [url=/articles/1]');
  });

  it('honours a smaller bound', () => {
    const big = Array.from(
      { length: 40 },
      (_, i) => `- link "Item ${String(i)}" [ref=l${String(i)}]`,
    );
    const outline = buildOutline(
      { text: big.join('\n'), maskedRefs: new Set() },
      BROWSER_MIN_CHARS,
    );
    expect(encodedLength(outline.text)).toBeLessThanOrEqual(BROWSER_MIN_CHARS);
    expect(outline.census).toBeDefined();
  });
});
