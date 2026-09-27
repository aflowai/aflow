import { describe, it, expect } from 'vitest';
import { sanitizeTerminalErrorMessage } from './errorMessageDisplay.js';

describe('sanitizeTerminalErrorMessage', () => {
  it('unwraps double-encoded Google JSON in error.message', () => {
    const inner = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
      },
    });
    const outer = JSON.stringify({ error: { message: inner } });
    const prefixed = `[step "agent" (agent) | ai.agent.turn] ${outer}`;
    const out = sanitizeTerminalErrorMessage(prefixed, 500);
    expect(out).toBe('API key not valid. Please pass a valid API key.');
  });

  it('returns short strings unchanged', () => {
    expect(sanitizeTerminalErrorMessage('Nothing to see here')).toBe('Nothing to see here');
  });

  it('caps length after unwrapping', () => {
    const long = 'x'.repeat(600);
    const wrapped = JSON.stringify({ error: { message: long } });
    const out = sanitizeTerminalErrorMessage(wrapped, 120);
    expect(out.length).toBe(120);
    expect(out.endsWith('...')).toBe(true);
  });
});
