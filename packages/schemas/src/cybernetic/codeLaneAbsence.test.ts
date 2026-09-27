import { describe, expect, it } from 'vitest';

import {
  CODE_LANE_ABSENT_CAPABILITY_ID,
  foldMissingCapabilitiesForAbsentCodeLane,
  isCodeLaneToken,
} from './skillProjection.js';

describe('foldMissingCapabilitiesForAbsentCodeLane', () => {
  it('passes every token through where a coding lane is composed', () => {
    const missing = ['code', 'code_repo', 'code_model:zai', 'search_provider'];
    expect(foldMissingCapabilitiesForAbsentCodeLane(missing, 'present')).toEqual(missing);
  });

  it('collapses the lane, repo and key tokens into one where no lane is composed', () => {
    expect(
      foldMissingCapabilitiesForAbsentCodeLane(
        ['code', 'code_repo', 'code_model:zai', 'code_model', 'search_provider'],
        'absent',
      ),
    ).toEqual([CODE_LANE_ABSENT_CAPABILITY_ID, 'search_provider']);
  });

  it('adds nothing when no lane token was missing', () => {
    expect(foldMissingCapabilitiesForAbsentCodeLane(['search_provider'], 'absent')).toEqual([
      'search_provider',
    ]);
    expect(foldMissingCapabilitiesForAbsentCodeLane([], 'absent')).toEqual([]);
  });

  it('recognises exactly the coding-lane tokens', () => {
    for (const token of ['code', 'code_repo', 'code_model', 'code_model:anthropic']) {
      expect(isCodeLaneToken(token)).toBe(true);
    }
    for (const token of ['compute', 'search_provider', 'codex', 'api:github']) {
      expect(isCodeLaneToken(token)).toBe(false);
    }
  });
});

describe('foldMissingCapabilitiesForAbsentCodeLane with an unknown lane', () => {
  it('folds nothing when the lane is not known to be absent', () => {
    const missing = ['code', 'code_repo', 'code_model:zai'];
    expect(foldMissingCapabilitiesForAbsentCodeLane(missing, undefined)).toEqual(missing);
  });
});
