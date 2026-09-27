import { describe, it, expect } from 'vitest';
import { validateIllustration } from './illustrationValidation.js';

/**
 * Generation-time validation is defence in depth, not the trust boundary —
 * the render boundary sanitizes independently. What it must guarantee is that
 * a producer emitting an execution vector gets told so, instead of a clean
 * bill of health that a reader might mistake for a safety property.
 */
const REJECTED: { name: string; svg: string }[] = [
  { name: 'script element', svg: '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>' },
  { name: 'onload', svg: '<svg viewBox="0 0 1 1" onload="alert(1)"><rect/></svg>' },
  { name: 'onpointerenter', svg: '<svg viewBox="0 0 1 1"><rect onpointerenter="alert(1)"/></svg>' },
  { name: 'onbegin', svg: '<svg viewBox="0 0 1 1"><animate onbegin="alert(1)"/></svg>' },
  { name: 'onfocusin', svg: '<svg viewBox="0 0 1 1"><rect onfocusin="alert(1)"/></svg>' },
  {
    name: 'javascript: href',
    svg: '<svg viewBox="0 0 1 1"><a href="javascript:alert(1)"><text>x</text></a></svg>',
  },
  {
    name: 'javascript: xlink:href',
    svg: '<svg viewBox="0 0 1 1"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  },
  {
    name: 'foreignObject',
    svg: '<svg viewBox="0 0 1 1"><foreignObject><b>x</b></foreignObject></svg>',
  },
  { name: 'iframe', svg: '<svg viewBox="0 0 1 1"><iframe src="/x"></iframe></svg>' },
  { name: 'base', svg: '<svg viewBox="0 0 1 1"><base href="https://evil.example/"/></svg>' },
  {
    name: 'external href',
    svg: '<svg viewBox="0 0 1 1"><use href="https://evil.example/x#a"/></svg>',
  },
  {
    name: 'external css url',
    svg: '<svg viewBox="0 0 1 1"><style>@import url(https://evil.example/x.css)</style></svg>',
  },
];

describe('validateIllustration', () => {
  for (const { name, svg } of REJECTED) {
    it(`rejects ${name}`, () => {
      expect(validateIllustration(svg).valid).toBe(false);
    });
  }

  it('rejects the combined handler-plus-script-url case', () => {
    const result = validateIllustration(
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<rect width="24" height="24" onpointerenter="alert(1)"/>' +
        '<a href="javascript:alert(1)"><text>click</text></a></svg>',
    );

    expect(result.valid).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('ILLUST_EVENT_HANDLER');
    expect(codes).toContain('ILLUST_SCRIPT_URL');
  });

  it('accepts a self-contained illustration', () => {
    const result = validateIllustration(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
        '<title>Chart</title>' +
        '<path d="M0 0 L24 24" stroke="currentColor" fill="none"/>' +
        '<circle cx="12" cy="12" r="4" fill="#3b82f6"/></svg>',
    );

    expect(result.valid).toBe(true);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0);
  });
});
