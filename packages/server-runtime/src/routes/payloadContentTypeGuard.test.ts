import { describe, expect, it } from 'vitest';
import { isInlineSafeContentType } from '../lib/servableContentType.js';
import { STORABLE_CONTENT_TYPES } from './payloads.js';

/**
 * Two lists, one shared hazard.
 *
 * What a caller may store and what a browser may be handed inline are different
 * questions with different answers, so the lists are not merged. They are
 * coupled in one direction only: a type storable here is eventually served, and
 * if the serving layer considers it script-capable then the write allowed an
 * object to be labelled something a browser will act on.
 *
 * Drift the other way is fine — the serving list may safely be broader.
 */
describe('storable content types', () => {
  it.each(STORABLE_CONTENT_TYPES)('%s is a type the serving layer will not neutralize', (type) => {
    expect(isInlineSafeContentType(type)).toBe(true);
  });
});
