import { expect, it } from 'vitest';
import { restrictedPlanWriteAuthority } from './writeAuthority.js';

it.each([
  [{ trigger: 'schedule', planResident: true }, true],
  [{ trigger: 'schedule', planResident: false }, false],
  [{ trigger: 'schedule' }, true],
  [null, true],
  [{}, true],
  [{ trigger: 'chat', planResident: true }, false],
  [{ trigger: 'voice', planResident: true }, false],
  [{ trigger: 'webhook', activatedByPerson: true }, false],
  [{ trigger: 'webhook', planResident: false }, true],
])('reads the recorded marker with schedule provenance (%j)', (state, restricted) => {
  expect(restrictedPlanWriteAuthority(state)).toBe(restricted);
});
