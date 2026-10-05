/**
 * Which triggers only a person uses, decided once for every trigger there is,
 * and the activation fact every command that sets a run going carries.
 */
import { describe, expect, it } from 'vitest';

import { isPersonTrigger, RunTriggerSchema } from '../runTrigger.js';
import {
  ControlMessageSchema,
  StartRunCommandSchema,
  StepJobMessageSchema,
} from '../streamMessages.js';

describe('isPersonTrigger', () => {
  it('classifies every trigger, so a new one fails here until someone decides it', () => {
    const classified = Object.fromEntries(
      RunTriggerSchema.options.map((trigger) => [trigger, isPersonTrigger(trigger)]),
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

  it('reads no recorded trigger as no surface only a person uses', () => {
    expect(isPersonTrigger(undefined)).toBe(false);
  });

  it('is read from one enum by the start message', () => {
    expect(StartRunCommandSchema.shape.trigger.unwrap()).toBe(RunTriggerSchema);
  });
});

describe('activatedByPerson', () => {
  const common = {
    tenantId: '00000000-0000-0000-0000-0000000000a1',
    runId: '00000000-0000-0000-0000-0000000000a2',
    traceId: 'trace-activation',
    idempotencyKey: 'activation-key',
    requestedAtMs: 1,
  };

  it.each([
    {
      type: 'start_run',
      target: { kind: 'platform-role', systemRole: 'helmsman' },
      agentVersion: '1',
      inputRef: 'inline:e30=',
      trigger: 'chat',
    },
    { type: 'retry_run' },
  ])('reads a $type command that does not say as nobody', (command) => {
    const parsed = ControlMessageSchema.parse({ ...common, ...command });
    expect(parsed).toMatchObject({ activatedByPerson: false });
  });

  it('reads a resume_run command that does not say as leaving the session as it is', () => {
    const parsed = ControlMessageSchema.parse({
      ...common,
      type: 'resume_run',
      stepExecutionId: '00000000-0000-0000-0000-0000000000a3',
      inputRef: 'inline:e30=',
    });
    expect(parsed).not.toHaveProperty('activatedByPerson');
  });

  it('is a boolean on the step job, absent when nothing recorded it', () => {
    const shape = StepJobMessageSchema.innerType().shape;
    expect(shape.activatedByPerson.safeParse(true).success).toBe(true);
    expect(shape.activatedByPerson.safeParse('chat').success).toBe(false);
    expect(shape.activatedByPerson.safeParse(undefined).success).toBe(true);
  });
});
