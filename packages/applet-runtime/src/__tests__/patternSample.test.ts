import { describe, expect, it } from 'vitest';
import { sampleStringForPattern } from '../patternSample.js';

describe('sampleStringForPattern', () => {
  it('builds the shortest match of a prefixed-id pattern', () => {
    expect(sampleStringForPattern('^sh_[0-9a-z]{8,24}$')).toBe('sh_00000000');
    expect(sampleStringForPattern('^mk_[0-9a-z]{6,20}$')).toBe('mk_000000');
  });

  it('handles ranges, single-char classes and open quantifiers', () => {
    expect(sampleStringForPattern('^[a-h][1-8]$')).toBe('a1');
    expect(sampleStringForPattern('^[a-z][a-z0-9_]{1,31}$')).toBe('aa');
    expect(sampleStringForPattern('^/[A-Za-z0-9._/-]{1,500}$')).toBe('/A');
    expect(sampleStringForPattern('^a+b*$')).toBe('a');
  });

  it('takes the shortest alternation branch and skips optional groups', () => {
    expect(sampleStringForPattern('^(?:alpha|xy)$')).toBe('xy');
    expect(sampleStringForPattern('^[a-h][1-8][a-h][1-8][qrbn]?$')).toBe('a1a1');
  });

  it('honours escapes and shorthand classes', () => {
    expect(sampleStringForPattern(String.raw`^\d{3}-\d{2}$`)).toBe('000-00');
    expect(sampleStringForPattern(String.raw`^v\d\.\d$`)).toBe('v0.0');
  });

  it('grows a quantifier to reach a minLength the pattern alone undershoots', () => {
    const sample = sampleStringForPattern('^[a-z]{1,12}$', 5);
    expect(sample).toBe('aaaaa');
  });

  it('returns undefined for constructs it does not model', () => {
    expect(sampleStringForPattern('^(?=x)a$')).toBeUndefined();
    expect(sampleStringForPattern(String.raw`^(a)\1$`)).toBeUndefined();
    expect(sampleStringForPattern(String.raw`^\bword$`)).toBeUndefined();
  });

  it('returns undefined rather than a string the pattern rejects', () => {
    expect(sampleStringForPattern('^[a-z]{2}$', 8)).toBeUndefined();
  });

  it('every sample it returns actually matches', () => {
    const patterns = [
      '^sh_[0-9a-z]{8,24}$',
      '^[a-z][a-z0-9_]{1,23}$',
      '^[a-z0-9][a-z0-9._-]{1,63}$',
      '^[a-h][1-8][a-h][1-8][qrbn]?$',
      String.raw`^\w+@\w+\.[a-z]{2,4}$`,
    ];
    for (const pattern of patterns) {
      const sample = sampleStringForPattern(pattern);
      expect(sample, pattern).toBeTypeOf('string');
      expect(new RegExp(pattern).test(sample!), pattern).toBe(true);
    }
  });
});
