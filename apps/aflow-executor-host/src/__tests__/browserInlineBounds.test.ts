/**
 * Every browser result reaches the agent inline by default: measured as the
 * platform measures it — the step's output as JSON against the threshold above
 * which it is stored and handed back as a path — on pages built to be as
 * expensive to encode as text gets, quotes and line breaks throughout. A cut
 * result says how much was left and how to get it.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { BROWSER_READ_MAX_CHARS, TOOL_RESULT_INLINE_MAX_CHARS } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';

import { createBrowserHandler } from '../handlers/browserHandler.js';
import { harness, RUN_A, type Harness } from './fixtures/fakeBrowser.js';

const URL_ = 'https://docs.example.com/reference';

const lines: string[] = ['- main [ref=e0]:'];
for (let i = 1; i <= 3_000; i += 1) {
  lines.push(`  - list [ref=g${String(i)}]:`);
  lines.push(`    - link "Read \\"part\\" ${String(i)}" [ref=l${String(i)}]:`);
  lines.push(`      - /url: /reference/${String(i)}?q="a"`);
  if (i % 5 === 0)
    lines.push(`  - heading "Section \\"${String(i)}\\"" [level=2] [ref=h${String(i)}]`);
}
const HUGE_SNAPSHOT = lines.join('\n');
const HUGE_TEXT = Array.from({ length: 6_000 }, (_, i) => `"${String(i)}"\n`).join('');

function heavy(): Harness {
  return harness({
    world: {
      sites: new Map([[URL_, { title: 'Reference', snapshot: HUGE_SNAPSHOT, text: HUGE_TEXT }]]),
    },
  });
}

async function run(
  h: Harness,
  operationId: string,
  input: unknown,
): Promise<Record<string, unknown>> {
  let written: unknown;
  const ctx = {
    tenantId: RUN_A.tenantId,
    runId: RUN_A.runId,
    spaceId: RUN_A.spaceId,
    attempt: 1,
    operationId,
    job: { inputRef: 'inline:input' },
    readPayload: () => Promise.resolve(input),
    writePayload: (_kind: string, data: unknown) => {
      written = data;
      return Promise.resolve('inline:output');
    },
  } as unknown as ExecutorContext;
  const result = await createBrowserHandler(h.driver).execute(ctx);
  expect(result.status, operationId).toBe('SUCCEEDED');
  return written as Record<string, unknown>;
}

function inline(output: unknown): number {
  return JSON.stringify(output).length;
}

describe('browser results and the inline threshold', () => {
  it('keeps the outline, the snapshot, page text and console under it by default', async () => {
    const h = heavy();
    const opened = await run(h, 'browser.page.open', { url: URL_ });
    const pageId = opened['pageId'] as string;
    for (let i = 0; i < 400; i += 1) {
      h.pages[0]?.events.console('error', `"failure ${String(i)}"\n${'x'.repeat(60)}`);
    }

    const outputs = {
      open: opened,
      snapshot: await run(h, 'browser.page.snapshot', { pageId }),
      text: await run(h, 'browser.page.read', { pageId, what: 'text' }),
      console: await run(h, 'browser.page.read', { pageId, what: 'console' }),
      act: await run(h, 'browser.page.act', { pageId, ref: 'l1', action: 'hover' }),
    };
    for (const [name, output] of Object.entries(outputs)) {
      expect(inline(output), name).toBeLessThanOrEqual(TOOL_RESULT_INLINE_MAX_CHARS);
    }
  });

  it('says, when cut, how to get the rest', async () => {
    const h = heavy();
    const opened = await run(h, 'browser.page.open', { url: URL_ });
    const pageId = opened['pageId'] as string;
    expect(opened['outline']).toMatch(/browser\.page\.snapshot with a `ref`.*raise `maxChars`\.$/);

    const snapshot = await run(h, 'browser.page.snapshot', { pageId });
    const receipt = snapshot['receipt'] as { cut: boolean; continueRef?: string };
    expect(receipt.cut).toBe(true);
    expect(receipt.continueRef).toMatch(/^g\d+$/);
    expect(snapshot['snapshot']).toContain(`snapshot with \`ref: ${receipt.continueRef ?? ''}\``);
    const onward = await run(h, 'browser.page.snapshot', { pageId, ref: receipt.continueRef });
    expect(onward['snapshot']).toMatch(/^- list \[ref=g\d+\]:/);

    const first = await run(h, 'browser.page.read', { pageId, what: 'text' });
    const next = first['nextOffset'] as number;
    expect(first['withheld']).toBe(HUGE_TEXT.length - next);
    const second = await run(h, 'browser.page.read', { pageId, what: 'text', offset: next });
    expect([first['offset'], second['offset']]).toEqual([0, next]);
    expect((first['text'] as string) + (second['text'] as string)).toBe(
      HUGE_TEXT.slice(0, next + (second['text'] as string).length),
    );
  });

  it('returns more when the call asks, up to the ceiling', async () => {
    const h = heavy();
    const opened = await run(h, 'browser.page.open', { url: URL_ });
    const pageId = opened['pageId'] as string;
    const wide = await run(h, 'browser.page.read', {
      pageId,
      what: 'text',
      maxChars: BROWSER_READ_MAX_CHARS,
    });
    expect(inline(wide)).toBeGreaterThan(TOOL_RESULT_INLINE_MAX_CHARS);
    expect(inline(wide)).toBeLessThanOrEqual(BROWSER_READ_MAX_CHARS + 500);
  });
});
