import { expect, it } from 'vitest';
import { planResidentSessionMarker } from './planResidentSession.js';
const target = { kind: 'platform-role', systemRole: 'cybernetic-helmsman' };
const input = { config: { scheduleId: '00000000-0000-4000-8000-000000000331' } };
it('marks only scheduled Helmsman starts with the resident schedule input', () => {
  expect(planResidentSessionMarker('schedule', target, input)).toBe(true);
  expect(planResidentSessionMarker('chat', target, input)).toBe(false);
  expect(planResidentSessionMarker('schedule', { kind: 'custom-agent' }, input)).toBe(false);
  expect(planResidentSessionMarker('schedule', target, {})).toBe(false);
  expect(planResidentSessionMarker('schedule', target, { config: { scheduleId: '' } })).toBe(false);
});
