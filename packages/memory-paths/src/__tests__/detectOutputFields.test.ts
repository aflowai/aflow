import { describe, it, expect } from 'vitest';
import { detectOutputFields } from '../detectOutputFields.js';

describe('detectOutputFields', () => {
  it('detects API response fields', () => {
    expect(detectOutputFields({ data: '...', statusCode: 200, body: '...' })).toEqual([
      'data',
      'body',
    ]);
  });

  it('detects compute output with outputFiles', () => {
    expect(
      detectOutputFields({
        data: 'stdout',
        exitCode: 0,
        outputFiles: { 'submission.csv': '...', 'model.pkl': '...' },
      }),
    ).toEqual(['data', 'outputFiles/submission.csv', 'outputFiles/model.pkl']);
  });

  it('detects memory get output', () => {
    expect(detectOutputFields({ data: 'content', stat: {} })).toEqual(['data']);
  });

  it('returns actual top-level keys for generic output', () => {
    expect(detectOutputFields({ result: true })).toEqual(['result']);
  });

  it('returns content for MCP-shaped output', () => {
    expect(detectOutputFields({ content: [{ type: 'text', text: '{}' }] })).toEqual(['content']);
  });

  it('returns empty for null/undefined/scalars/arrays', () => {
    expect(detectOutputFields(null)).toEqual([]);
    expect(detectOutputFields(undefined)).toEqual([]);
    expect(detectOutputFields('text')).toEqual([]);
    expect(detectOutputFields([1, 2])).toEqual([]);
  });
});
