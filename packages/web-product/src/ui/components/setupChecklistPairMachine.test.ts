/**
 * The host lane's post-install row opens This Computer, a surface only the
 * local edition composes. `useHasSurface('host-bindings')` answers a different
 * question — that route is registered `core` and exists in both editions,
 * declining at runtime instead — so the gate has to be the edition itself.
 *
 * What the row renders is read from source, because the invariant is about the
 * tree and the package carries no renderable test surface; what it says per
 * edition is a fold, and is called.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { pairMachineLine } from './setup-checklist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'setup-checklist.tsx'), 'utf8');

/** The braced expression starting at `marker`, matched by depth. */
function blockFrom(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces from marker: ${marker}`);
}

/** One top-level function declaration's source, up to the next one. */
function declarationOf(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `declaration not found: ${name}`).toBeGreaterThan(-1);
  const next = src.indexOf('\nfunction ', start + 1);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe('pair_machine row — setup checklist', () => {
  it('renders a row of its own for the pair_machine task kind', () => {
    expect(SRC).toContain("task.kind === 'pair_machine'");
    expect(SRC).toContain('function PairMachineRow');
  });

  it('gates the This Computer link on the local edition, not on a surface name', () => {
    expect(SRC).toContain('useEdition()');
    expect(SRC).not.toContain('useHasSurface');
    const gate = blockFrom(SRC, "{edition.id === 'community-local' &&");
    expect(gate).toContain("'/computer'");
    expect(
      countOf(SRC, "'/computer'"),
      'This Computer is linked outside the local-edition gate',
    ).toBe(countOf(gate, "'/computer'"));
  });

  it('tells a hosted operator what is missing instead of offering the link', () => {
    const line = pairMachineLine('enterprise', 'Pair a machine to run this skill.');
    expect(line).toContain('Aflow Local');
    expect(line).not.toContain('Pair a machine to run this skill.');
  });

  it('carries the description the task itself carries on the local edition', () => {
    expect(pairMachineLine('community-local', 'Pair a machine to run this skill.')).toBe(
      'Pair a machine to run this skill.',
    );
  });

  /**
   * The row used to render a title, the local description and no button while
   * the edition was unresolved — a promise of a control that was not there.
   */
  it('says it is still establishing the edition rather than standing empty', () => {
    expect(pairMachineLine(null, 'Pair a machine to run this skill.')).toBe(
      'Checking which edition this is…',
    );
  });

  it('withholds the button until the edition is known', () => {
    const row = declarationOf(SRC, 'PairMachineRow');
    // The gate is an equality on the local edition, so the unresolved `null`
    // fails it without a case of its own.
    expect(row).toContain("edition.id === 'community-local' &&");
  });
});
