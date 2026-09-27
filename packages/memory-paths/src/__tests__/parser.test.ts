import { describe, it, expect } from 'vitest';
import { isVirtualPath, isWritablePath, parseOutputPath } from '../parser.js';

describe('isVirtualPath', () => {
  it('returns true for /run/ paths', () => {
    expect(isVirtualPath('/run/outputs/abc/data')).toBe(true);
    expect(isVirtualPath('/run/outputs/')).toBe(true);
    expect(isVirtualPath('/run/anything')).toBe(true);
  });

  it('returns false for persistent paths', () => {
    expect(isVirtualPath('/data/train.csv')).toBe(false);
    expect(isVirtualPath('/scripts/pipeline.py')).toBe(false);
    expect(isVirtualPath('/')).toBe(false);
  });
});

describe('isWritablePath', () => {
  it('returns false for virtual paths', () => {
    expect(isWritablePath('/run/outputs/abc/data')).toBe(false);
  });

  it('returns true for persistent paths', () => {
    expect(isWritablePath('/data/train.csv')).toBe(true);
    expect(isWritablePath('/')).toBe(true);
  });
});

describe('parseOutputPath', () => {
  it('parses toolCallId only', () => {
    expect(parseOutputPath('/run/outputs/call_abc')).toEqual({
      toolCallId: 'call_abc',
    });
  });

  it('parses toolCallId with field pointer', () => {
    expect(parseOutputPath('/run/outputs/call_abc/data')).toEqual({
      toolCallId: 'call_abc',
      fieldPointer: '/data',
    });
  });

  it('parses nested field pointer', () => {
    expect(parseOutputPath('/run/outputs/call_abc/files/submission.csv')).toEqual({
      toolCallId: 'call_abc',
      fieldPointer: '/files/submission.csv',
    });
  });

  it('returns null for non-output paths', () => {
    expect(parseOutputPath('/data/train.csv')).toBeNull();
    expect(parseOutputPath('/run/state/foo')).toBeNull();
  });

  it('returns null for bare /run/outputs/', () => {
    expect(parseOutputPath('/run/outputs/')).toBeNull();
  });
});
