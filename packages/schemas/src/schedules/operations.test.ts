import { describe, expect, it } from 'vitest';
import { FlowScheduleCreateInputSchema, MAX_FIRINGS_CAP } from './operations.js';
import { toJsonSchemaSync } from '../utils/jsonSchema.js';

const cronBase = {
  name: 'daily-trading-cycle-morning',
  action: 'start_run' as const,
  target: { kind: 'platform-role' as const, systemRole: 'cybernetic-helmsman' },
  cron: '35 9 * * 1-5',
  timezone: 'America/New_York',
  input: {},
};

describe('FlowScheduleCreateInputSchema — maxFirings', () => {
  it('a cron schedule without maxFirings validates and defaults to the cap (no fumble)', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse(cronBase);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.maxFirings).toBe(MAX_FIRINGS_CAP);
  });

  it('an explicit maxFirings is preserved', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({ ...cronBase, maxFirings: 10 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.maxFirings).toBe(10);
  });

  it('maxFirings over the cap is still rejected', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({
      ...cronBase,
      maxFirings: MAX_FIRINGS_CAP + 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('a one-shot without maxFirings validates (the handler forces 1 at runtime)', () => {
    const parsed = FlowScheduleCreateInputSchema.safeParse({
      name: 'one-shot-test',
      action: 'start_run',
      target: { kind: 'platform-role', systemRole: 'cybernetic-helmsman' },
      scheduledAt: '2026-08-01T13:35:00Z',
      input: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('maxFirings is optional in the emitted JSON Schema — the agent never sees it as required', () => {
    const jsonSchema = toJsonSchemaSync(FlowScheduleCreateInputSchema) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(jsonSchema.properties).toHaveProperty('maxFirings');
    expect(jsonSchema.required ?? []).not.toContain('maxFirings');
  });
});
