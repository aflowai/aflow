/**
 * The roster is asked for only where something serves it.
 *
 * `/spaces/:id/members` belongs to an edition that has members; the single-user
 * edition composes no such route, so an ungated query spends a 404 on every
 * dashboard load — held by the chat page, the Room control and every Workbench
 * row — and reports nothing for it. The API is right to refuse; the asking is the
 * defect, and it is invisible because the roster degrades to empty rather than
 * failing.
 *
 * Read from source because the hook needs React rendered around it to observe,
 * and the invariant is about which question is asked before the request goes out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, './use-space-people.ts'), 'utf8');

describe('the space roster query', () => {
  it('asks the edition whether a roster exists before requesting one', () => {
    expect(SRC).toContain("useHasSurface('space-members')");
  });

  it('gates the request on that answer, not only on having a space', () => {
    const enabled = SRC.match(/enabled:\s*([^,\n]+)/)?.[1] ?? '';
    expect(enabled, 'the roster request is not gated on the surface').toContain('hasSpaceMembers');
  });
});
