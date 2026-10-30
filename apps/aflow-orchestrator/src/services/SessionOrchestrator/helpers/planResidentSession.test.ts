import { expect, it } from 'vitest';
import { planResidentSessionMarker } from './planResidentSession.js';
const target = { kind: 'platform-role', systemRole: 'cybernetic-helmsman' };
const scheduleId = '00000000-0000-4000-8000-000000000331';
it('marks only scheduled Helmsman starts with a server-carried resident identity', () => {
  expect(planResidentSessionMarker('schedule', target, scheduleId)).toBe(true);
  expect(planResidentSessionMarker('chat', target, scheduleId)).toBe(false);
  expect(planResidentSessionMarker('webhook', target, scheduleId)).toBe(false);
  expect(planResidentSessionMarker('schedule', { kind: 'custom-agent' }, scheduleId)).toBe(false);
  expect(planResidentSessionMarker('schedule', target, undefined)).toBe(false);
  expect(planResidentSessionMarker('schedule', target, '')).toBe(false);
});
