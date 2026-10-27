/**
 * The host lane's post-install rows open This Computer, a surface only the
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

import {
  HOST_LANE_FOLDER_REFUSAL,
  HOST_LANE_HARNESS_REFUSAL,
  HOST_LANE_PAIRING_REFUSAL,
} from '@aflow/schemas';
import { hostLaneLine, type HostLaneTask } from './setup-checklist.js';

const MACHINE: HostLaneTask = {
  kind: 'pair_machine',
  reading: 'machine',
  state: 'needs_setup',
  page: '/computer',
  description: 'Pair a machine to run this skill.',
  required: true,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'setup-checklist.tsx'), 'utf8');

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

describe('host lane rows — setup checklist', () => {
  it('renders the pair_machine readings, the coding agent and the preview in a row of their own', () => {
    expect(SRC).toContain("task.kind === 'pair_machine'");
    expect(SRC).toContain("task.kind === 'coding_harness'");
    expect(SRC).toContain('function HostLaneRow');
  });

  it('gates the This Computer link on the local edition, not on a surface name', () => {
    expect(SRC).toContain('useEdition()');
    expect(SRC).not.toContain('useHasSurface');
    const row = declarationOf(SRC, 'HostLaneRow');
    const gate = row.slice(row.indexOf("edition.id === 'community-local' &&"));
    expect(gate).toContain("'/computer'");
    expect(
      countOf(SRC, "'/computer'"),
      'This Computer is linked outside the local-edition gate',
    ).toBe(countOf(gate, "'/computer'"));
  });

  it('tells a hosted operator what is missing instead of offering the link', () => {
    const line = hostLaneLine('enterprise', MACHINE);
    expect(line).toBe(HOST_LANE_PAIRING_REFUSAL);
    expect(line).toContain('Aflow Local');
    expect(line).not.toContain('Pair a machine to run this skill.');
  });

  it('gives each host-lane item its own edition refusal', () => {
    expect(hostLaneLine('enterprise', { ...MACHINE, reading: 'folder' })).toBe(
      HOST_LANE_FOLDER_REFUSAL,
    );
    expect(
      hostLaneLine('enterprise', {
        kind: 'coding_harness',
        state: 'broken',
        page: '/computer',
        chosen: null,
        options: [],
        description: 'Choose the coding agent.',
        required: true,
      }),
    ).toBe(HOST_LANE_HARNESS_REFUSAL);
  });

  it('carries the description the task itself carries on the local edition', () => {
    expect(hostLaneLine('community-local', MACHINE)).toBe('Pair a machine to run this skill.');
  });

  /**
   * The row used to render a title, the local description and no button while
   * the edition was unresolved — a promise of a control that was not there.
   */
  it('says it is still establishing the edition rather than standing empty', () => {
    expect(hostLaneLine(null, MACHINE)).toBe('Checking which edition this is…');
  });

  it('withholds the button until the edition is known', () => {
    const row = declarationOf(SRC, 'HostLaneRow');
    // The gate is an equality on the local edition, so the unresolved `null`
    // fails it without a case of its own.
    expect(row).toContain("edition.id === 'community-local' &&");
  });
});
