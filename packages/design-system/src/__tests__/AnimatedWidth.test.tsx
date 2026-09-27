import { describe, it, expect } from 'vitest';
import { AnimatedWidth, toCssWidth } from '../components/AnimatedWidth.js';

describe('AnimatedWidth', () => {
  it('is exported as a component', () => {
    expect(typeof AnimatedWidth).toBe('function');
  });

  it('toCssWidth treats numbers as px and passes strings through', () => {
    expect(toCssWidth(320)).toBe('320px');
    expect(toCssWidth(0)).toBe('0px');
    expect(toCssWidth('20rem')).toBe('20rem');
    expect(toCssWidth('100%')).toBe('100%');
  });
});
