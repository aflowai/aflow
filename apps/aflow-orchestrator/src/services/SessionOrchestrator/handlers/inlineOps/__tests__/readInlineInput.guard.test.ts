/**
 * Guard: every inline handler reads its resolved input through
 * `readInlineInput`. A handler that retrieves the ref itself grows a bare
 * try/catch around the call, and the catch turns a present ref that cannot be
 * read into `{}` — the op then runs on defaults while its input sits unread.
 *
 * Scans every handler source under `handlers/inlineOps/`, so a new handler is
 * covered without touching this file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const INLINE_OPS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The shared reader, and `readInlineOpInput` — a pass-through with no catch of
 * its own, so a failed read still propagates from it.
 */
const ALLOWED = new Set(['readInlineInput.ts', 'helpers.ts']);

const DIRECT_INPUT_RETRIEVE = /\.retrieve\(\s*(?:args\.)?resolvedInputRef\b/;
const SWALLOWED_RECORD_READ = /readInlineOpInputRecord\([^)]*\)\)\s*\?\?\s*\{\s*\}/;

function handlerSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : handlerSources(path);
    }
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [path] : [];
  });
}

function violations(source: string): string[] {
  const found: string[] = [];
  if (DIRECT_INPUT_RETRIEVE.test(source)) {
    found.push('calls payloadStore.retrieve on its resolved input ref');
  }
  if (SWALLOWED_RECORD_READ.test(source)) {
    found.push('defaults an unreadable input ref to {}');
  }
  return found;
}

describe('inline handlers read their input through readInlineInput', () => {
  it('detects the swallowing read it guards against', () => {
    const swallowing = [
      'let input: Record<string, unknown> = {};',
      'try {',
      '  const data = await payloadStore.retrieve(resolvedInputRef);',
      '  if (typeof data === "object" && data !== null) input = data;',
      '} catch {',
      '  /* empty input */',
      '}',
    ].join('\n');
    expect(violations(swallowing)).toHaveLength(1);
    expect(
      violations('raw = await args.payloadStore.retrieve(args.resolvedInputRef);'),
    ).toHaveLength(1);
    expect(violations('const input = (await readInlineOpInputRecord(args)) ?? {};')).toHaveLength(
      1,
    );
    expect(violations('const input = await readInlineInput(args, startTime);')).toEqual([]);
  });

  it('finds the handlers it scans', () => {
    const names = handlerSources(INLINE_OPS_DIR).map((path) => relative(INLINE_OPS_DIR, path));
    expect(names).toEqual(
      expect.arrayContaining([
        'agentCrud.ts',
        'apiAdmin.ts',
        'apiDiscovery.ts',
        'catalogAgent.ts',
        'catalogExport.ts',
        'artifactInspect.ts',
        join('workflowCrud', 'handleInline.ts'),
      ]),
    );
  });

  it('no handler retrieves its resolved input ref itself', () => {
    const offenders = handlerSources(INLINE_OPS_DIR)
      .filter((path) => !ALLOWED.has(relative(INLINE_OPS_DIR, path)))
      .flatMap((path) =>
        violations(readFileSync(path, 'utf8')).map(
          (reason) => `${relative(INLINE_OPS_DIR, path)}: ${reason}`,
        ),
      );
    expect(offenders, 'read the input with readInlineInput(args, startTime)').toEqual([]);
  });
});
