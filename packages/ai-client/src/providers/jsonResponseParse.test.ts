import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from './jsonResponseParse.js';

describe('parseJsonResponse', () => {
  it('parses a clean JSON object', () => {
    const result = parseJsonResponse('{"action":"complete","result":"ok"}');
    expect(result.parsed).toEqual({ action: 'complete', result: 'ok' });
    expect(result.repaired).toBe(false);
  });

  it('recovers when the model emits a second JSON object after the first', () => {
    const content = '{"action":"complete","result":"ok"}\n{"trailing":"junk"}';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete', result: 'ok' });
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('trailing_content');
  });

  it('recovers when the model appends prose after the JSON', () => {
    const content = '{"action":"complete","result":"ok"}\nThis is some explanatory text.';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete', result: 'ok' });
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('trailing_content');
  });

  it('strips a fenced ```json block', () => {
    const content = '```json\n{"action":"complete"}\n```';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete' });
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('code_fence');
  });

  it('strips a bare ``` fence', () => {
    const content = '```\n{"action":"complete"}\n```';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete' });
    expect(result.repaired).toBe(true);
  });

  it('parses arrays at the top level', () => {
    const result = parseJsonResponse('[1,2,3]');
    expect(result.parsed).toEqual([1, 2, 3]);
    expect(result.repaired).toBe(false);
  });

  it('handles braces inside string values without false positives', () => {
    const content = '{"message":"a } b { c","ok":true}\nextra';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ message: 'a } b { c', ok: true });
    expect(result.repaired).toBe(true);
  });

  it('throws on truly malformed JSON with no recoverable prefix', () => {
    expect(() => parseJsonResponse('not json at all')).toThrow();
  });

  it('throws when content is an unterminated object', () => {
    expect(() => parseJsonResponse('{"action":"complete"')).toThrow();
  });

  it('recovers when the model prefixes JSON with prose ("Perfect! ..." then JSON)', () => {
    const content = 'Perfect! The decision is clear:\n{"action":"complete","result":"ok"}';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete', result: 'ok' });
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('leading_prose');
  });

  it('recovers from prose on both sides of the JSON', () => {
    const content =
      'Sure! Here we go:\n{"action":"invoke_step","toolId":"x","args":{}}\nLet me know if you need anything else.';
    const result = parseJsonResponse(content);
    expect((result.parsed as { action: string }).action).toBe('invoke_step');
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('leading_prose');
  });

  it('skips a stray "{" inside prose and finds the real JSON object after it', () => {
    const content = 'I might set { something later, but for now: {"action":"complete"}';
    const result = parseJsonResponse(content);
    expect(result.parsed).toEqual({ action: 'complete' });
    expect(result.repaired).toBe(true);
  });

  it('reproduces the Coach failure: position 706 trailing newline + second block', () => {
    const first = JSON.stringify({
      action: 'complete',
      result: JSON.stringify({
        outcome: 'with_proposals',
        proposalIds: ['stg_1', 'stg_2'],
        rationale: 'Multiple criteria failed; proposals filed by category.',
      }),
    });
    const trailing = '\n{"action":"pause_for_input","message":"unwanted second block"}';
    const result = parseJsonResponse(first + trailing);
    expect((result.parsed as { action: string }).action).toBe('complete');
    expect(result.repaired).toBe(true);
    expect(result.repairReason).toBe('trailing_content');
  });
});
