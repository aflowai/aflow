import { describe, expect, it } from 'vitest';
import { formatAjvError } from '../agentOutputValidator.js';

/**
 * One addressing scheme for the draft.
 *
 * A validation failure names where it failed, and that name has to be the
 * thing the agent can hand straight to `draft_patch` and `draft_get`. Two
 * conventions over one document is a difference an author cannot discover
 * until a read comes back empty, and the whole repair loop depends on this
 * correspondence holding.
 */
describe('a validation error names an address the draft tools accept', () => {
  it('reports a JSON Pointer, which is what draft_patch takes', () => {
    const line = formatAjvError({
      instancePath: '/cases/1/expectations/1/check',
      keyword: 'additionalProperties',
      params: { additionalProperty: 'inField' },
    } as never);
    expect(line.startsWith('/cases/1/expectations/1/check')).toBe(true);

    // The repair is that pointer, verbatim — no translation step.
    const pointer = line.split(':')[0]!;
    expect(pointer.startsWith('/')).toBe(true);
    expect(pointer).not.toContain('.');
  });

  it('reports the document root as a pointer too', () => {
    const line = formatAjvError({
      instancePath: '',
      keyword: 'required',
      params: { missingProperty: 'cases' },
    } as never);
    expect(line.startsWith('/')).toBe(true);
  });
});
