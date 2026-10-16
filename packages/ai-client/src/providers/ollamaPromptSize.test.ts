import { describe, expect, it } from 'vitest';
import { sizePrompt } from './ollamaPromptSize.js';

describe('sizePrompt', () => {
  it('bounds a prompt between the lowest and highest measured characters per token', () => {
    const text = 'The orchestrator schedules each tool call as its own step. '.repeat(20);
    const sizing = sizePrompt([{ content: text }]);

    // English runs at about 4.8 characters a token, so the true count sits between the two.
    const actual = text.length / 4.8;
    expect(sizing.conservativeTokens).toBeGreaterThan(actual);
    expect(sizing.lowerBoundTokens).toBeLessThan(actual);
    expect(sizing.needsExactCount).toBe(false);
  });

  it('never overstates the floor for padding, indentation or rules of one character', () => {
    // A run of one character can be a single token however long it is; a
    // floor that counted it would read a legitimate prompt as a truncated one.
    const padded = `${' '.repeat(5000)}${'-'.repeat(5000)}x`;
    expect(sizePrompt([{ content: padded }]).lowerBoundTokens).toBe(0);
  });

  it('counts tool schemas and tool calls toward both bounds', () => {
    const bare = sizePrompt([{ content: 'Say ok.' }]);
    const withTools = sizePrompt(
      [
        {
          content: 'Say ok.',
          tool_calls: [{ function: { name: 'read', arguments: { path: '/a' } } }],
        },
      ],
      [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    );
    expect(withTools.conservativeTokens).toBeGreaterThan(bare.conservativeTokens);
    expect(withTools.lowerBoundTokens).toBeGreaterThan(bare.lowerBoundTokens);
  });

  it('asks for an exact count whenever an image is in the prompt', () => {
    expect(sizePrompt([{ content: 'What is this?', images: ['iVBOR'] }]).needsExactCount).toBe(
      true,
    );
  });
});
