import { describe, expect, it } from 'vitest';
import { UpdateScheduleBodySchema } from './schemas.js';

describe('UpdateScheduleBodySchema', () => {
  it('takes the reason for a pause in whatever length the person writes it', () => {
    const why = 'Pausing the resident while the review base is repaired; resume once main is green. '.repeat(30);
    const parsed = UpdateScheduleBodySchema.safeParse({ status: 'paused', why });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.why).toBe(why.trim());
  });

  it('still refuses an empty reason', () => {
    expect(UpdateScheduleBodySchema.safeParse({ status: 'paused', why: '  ' }).success).toBe(false);
  });
});
