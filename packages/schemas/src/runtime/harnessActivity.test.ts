import { describe, expect, it } from 'vitest';

import { HarnessActivityLineSchema } from './harnessActivity.js';
import { LiveDeltaChannelSchema } from './streamMessages.js';

describe('the live channels', () => {
  it('carries what a step is doing on a channel of its own', () => {
    // Folded into `text` these lines would render as the agent's own message.
    expect(LiveDeltaChannelSchema.options).toContain('activity');
    expect(LiveDeltaChannelSchema.options).toEqual(['text', 'thinking', 'activity']);
  });
});

describe('an activity line', () => {
  it('accepts each kind with what that kind needs', () => {
    expect(
      HarnessActivityLineSchema.parse({ kind: 'status', at: 0, text: 'Model glm-pro' }).kind,
    ).toBe('status');
    expect(
      HarnessActivityLineSchema.parse({ kind: 'thought', at: 12, text: 'Reading the diff.' }).kind,
    ).toBe('thought');
    expect(
      HarnessActivityLineSchema.parse({
        kind: 'tool',
        at: 20,
        tool: 'Read',
        text: 'Read packages/ai-client/src/providers/xai.ts',
      }).kind,
    ).toBe('tool');
    const result = HarnessActivityLineSchema.parse({
      kind: 'tool_result',
      at: 30,
      tool: 'Bash',
      ok: false,
      text: 'command not found',
    });
    expect(result).toMatchObject({ kind: 'tool_result', ok: false });
  });

  it('refuses a tool line with no tool, and a result with no verdict', () => {
    expect(
      HarnessActivityLineSchema.safeParse({ kind: 'tool', at: 1, text: 'something happened' })
        .success,
    ).toBe(false);
    expect(
      HarnessActivityLineSchema.safeParse({ kind: 'tool_result', at: 1, tool: 'Bash', text: 'ok' })
        .success,
    ).toBe(false);
  });

  it('refuses a kind nothing renders', () => {
    expect(
      HarnessActivityLineSchema.safeParse({ kind: 'debug', at: 1, text: 'internals' }).success,
    ).toBe(false);
  });

  it('takes a paragraph of model prose, which is what a harness writes', () => {
    const prose = 'a'.repeat(4000);
    expect(
      HarnessActivityLineSchema.safeParse({ kind: 'thought', at: 1, text: prose }).success,
    ).toBe(true);
  });

  it('is written and read back over the wire as one line', () => {
    const line = { kind: 'tool' as const, at: 42, tool: 'Grep', text: 'Grep emitLiveDelta' };
    const encoded = JSON.stringify(line);
    expect(encoded).not.toContain('\n');
    expect(HarnessActivityLineSchema.parse(JSON.parse(encoded))).toEqual(line);
  });
});
