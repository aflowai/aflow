/**
 * Whether a person started a run, decided once for every trigger there is.
 */
import { describe, expect, it } from 'vitest';

import { isAttendedRun, RunTriggerSchema } from '../runTrigger.js';
import { StartRunCommandSchema, StepJobMessageSchema } from '../streamMessages.js';

describe('isAttendedRun', () => {
  it('classifies every trigger, so a new one fails here until someone decides it', () => {
    const classified = Object.fromEntries(
      RunTriggerSchema.options.map((trigger) => [trigger, isAttendedRun(trigger)]),
    );
    expect(classified).toEqual({
      chat: true,
      voice: true,
      api: false,
      eval: false,
      mcp: false,
      schedule: false,
      webhook: false,
    });
  });

  it('reads a run with no recorded trigger as one nobody started', () => {
    expect(isAttendedRun(undefined)).toBe(false);
  });

  it('is read from one enum by the start message and the step job alike', () => {
    expect(StartRunCommandSchema.shape.trigger.unwrap()).toBe(RunTriggerSchema);
    expect(StepJobMessageSchema.innerType().shape.rootTrigger.unwrap()).toBe(RunTriggerSchema);
  });
});
