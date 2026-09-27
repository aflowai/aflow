import { describe, expect, it } from 'vitest';
import { WorkflowTaskSchema } from '../index.js';

const BASE = { taskId: 'poll-lb', name: 'Poll LB', goal: 'poll the leaderboard' };

const OP = { ...BASE, type: 'operation', operation: 'mcp.tool.call' };

describe('WorkflowTaskSchema.outputProjection (Plan 194 §4.3)', () => {
  it('accepts a projection on an operation task and defaults onMissing to error', () => {
    const parsed = WorkflowTaskSchema.parse({
      ...OP,
      outputProjection: {
        status: { path: 'status' },
        lbValue: {
          path: 'content[0].text',
          parse: ['json', 'number'],
          select: 'publicScore',
          onMissing: 'null',
        },
        submissionId: { fromInput: 'submissionId' },
      },
    });
    const status = parsed.outputProjection?.['status'];
    expect(status && 'onMissing' in status ? status.onMissing : undefined).toBe('error');
  });

  it('rejects outputProjection on an agent task', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'agent',
      outputProjection: { status: { path: 'status' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'outputProjection')).toBe(true);
    }
  });

  it('rejects outputProjection on a human task', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...BASE,
      type: 'human',
      pauseInstruction: 'approve',
      outputProjection: { status: { path: 'status' } },
    });
    expect(result.success).toBe(false);
  });

  it("defaults parse to include 'json' when select is set (no parse)", () => {
    const result = WorkflowTaskSchema.safeParse({
      ...OP,
      outputProjection: { v: { path: 'a', select: 'b' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputProjection?.['v']).toMatchObject({ parse: ['json'] });
    }
  });

  it("prepends 'json' when select is set with a non-json parse", () => {
    const result = WorkflowTaskSchema.safeParse({
      ...OP,
      outputProjection: { v: { path: 'a', select: 'b', parse: ['number'] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.outputProjection?.['v']).toMatchObject({ parse: ['json', 'number'] });
    }
  });

  it("rejects the inverted parse order ['number','json']", () => {
    const result = WorkflowTaskSchema.safeParse({
      ...OP,
      outputProjection: { v: { path: 'a', parse: ['number', 'json'], select: 'b' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate parse steps', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...OP,
      outputProjection: { v: { path: 'a', parse: ['json', 'json'] } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the reserved _poll projected field name', () => {
    const result = WorkflowTaskSchema.safeParse({
      ...OP,
      outputProjection: { _poll: { path: 'status' } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.').includes('_poll'))).toBe(true);
    }
  });

  it('rejects unknown fields on either variant (strict)', () => {
    expect(
      WorkflowTaskSchema.safeParse({
        ...OP,
        outputProjection: { v: { path: 'a', bogus: true } },
      }).success,
    ).toBe(false);
    expect(
      WorkflowTaskSchema.safeParse({
        ...OP,
        outputProjection: { v: { fromInput: 'a', path: 'b' } },
      }).success,
    ).toBe(false);
  });
});
