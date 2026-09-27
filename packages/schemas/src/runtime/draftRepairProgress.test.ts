import { describe, expect, it } from 'vitest';
import {
  formatDraftRepairProgress,
  isDraftRepair,
  parseDraftRepairProgress,
} from './draftRepairProgress.js';

const msg = (revision: number, unmet: number) =>
  `${formatDraftRepairProgress({ revision, unmet })} Output validation failed. …`;

describe('progress is read structurally, not from prose', () => {
  it('round-trips through the marker it writes', () => {
    expect(parseDraftRepairProgress(msg(7, 12))).toEqual({ revision: 7, unmet: 12 });
  });

  it('is at the front, where the 500-character comparison can see it', () => {
    // The consecutive counter compares `message.slice(0, 500)`. A marker after
    // a long diagnostic list would not change that prefix.
    expect(msg(7, 12).indexOf('[draft rev')).toBe(0);
  });

  it('counts a later draft with fewer problems as repair', () => {
    expect(isDraftRepair(msg(7, 12), msg(8, 5))).toBe(true);
  });

  it('does not count a resubmission that fixed nothing', () => {
    expect(isDraftRepair(msg(7, 12), msg(8, 12))).toBe(false);
    expect(isDraftRepair(msg(7, 12), msg(8, 13))).toBe(false);
  });

  it('does not count the same revision submitted again', () => {
    expect(isDraftRepair(msg(7, 12), msg(7, 5))).toBe(false);
  });

  it('says nothing about submissions that carry no draft', () => {
    // A literal submit must keep paying the budget exactly as before.
    expect(isDraftRepair('Output validation failed. x', 'Output validation failed. y')).toBe(false);
    expect(isDraftRepair(undefined, msg(1, 3))).toBe(false);
  });
});
