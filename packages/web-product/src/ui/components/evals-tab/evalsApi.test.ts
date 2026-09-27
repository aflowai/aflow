/**
 * Pin/unpin move the ruler for EVERY batch, so the mutation's invalidation
 * set must prefix-cover every per-batch read — details and comparisons for
 * batches that were never selected included. TanStack invalidates by key
 * prefix; this proves the coverage as data.
 */
import { describe, expect, it } from 'vitest';
import type { QueryKey } from '@tanstack/react-query';
import { baselineMutationInvalidates, evalsKeys } from './evalsApi.js';

const SPACE = 'space-1';
const SLUG = 'summarize-weekly';
const SELECTED_BATCH = 'batch-selected';
const OTHER_BATCH = 'batch-other';

/** TanStack partial matching: an invalidation key hits every key it prefixes. */
function isPrefixOf(prefix: QueryKey, key: QueryKey): boolean {
  return prefix.length <= key.length && prefix.every((part, i) => key[i] === part);
}

function covered(key: QueryKey): boolean {
  return baselineMutationInvalidates(SPACE, SLUG).some((prefix) => isPrefixOf(prefix, key));
}

describe('baselineMutationInvalidates', () => {
  it('covers the baseline read and the batch list', () => {
    expect(covered(evalsKeys.baseline(SPACE, SLUG))).toBe(true);
    expect(covered(evalsKeys.batches(SPACE, SLUG))).toBe(true);
  });

  it('covers batch details AND comparisons for every batch, not just the selected one', () => {
    for (const batchId of [SELECTED_BATCH, OTHER_BATCH]) {
      expect(covered(evalsKeys.batchDetail(SPACE, batchId))).toBe(true);
      expect(covered(evalsKeys.comparison(SPACE, batchId))).toBe(true);
    }
  });

  it('stays inside the space — another space’s cached evals are untouched', () => {
    expect(covered(evalsKeys.batchDetail('space-2', SELECTED_BATCH))).toBe(false);
    expect(covered(evalsKeys.comparison('space-2', SELECTED_BATCH))).toBe(false);
  });

  it('comparison keys nest under the per-batch detail key — one prefix invalidates both', () => {
    const detail = evalsKeys.batchDetail(SPACE, SELECTED_BATCH);
    expect(isPrefixOf(detail, evalsKeys.comparison(SPACE, SELECTED_BATCH))).toBe(true);
    expect(isPrefixOf(evalsKeys.batchData(SPACE), detail)).toBe(true);
  });

  it('trial keys extend the per-batch detail key, so pin/unpin and cancel already reach them', () => {
    const trial = evalsKeys.trial(SPACE, SELECTED_BATCH, 'case-1', 3);
    expect(trial).toEqual(['space', SPACE, 'eval-batch', SELECTED_BATCH, 'trial', 'case-1', 3]);
    expect(isPrefixOf(evalsKeys.batchDetail(SPACE, SELECTED_BATCH), trial)).toBe(true);
    expect(covered(trial)).toBe(true);
    expect(covered(evalsKeys.trial('space-2', SELECTED_BATCH, 'case-1', 3))).toBe(false);
  });

  it('the trial segment keeps a trial key from colliding with the comparison sibling', () => {
    expect(
      isPrefixOf(
        evalsKeys.comparison(SPACE, SELECTED_BATCH),
        evalsKeys.trial(SPACE, SELECTED_BATCH, 'case-1', 3),
      ),
    ).toBe(false);
  });
});
