import type { AppletTemplatePatchOp } from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { AppletTemplateError } from '../errors.js';
import { materializeAppletTemplatePatch } from '../template.js';

function expectTemplateError(fn: () => void, code: AppletTemplateError['code']): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppletTemplateError);
    expect((err as AppletTemplateError).code).toBe(code);
    return;
  }
  expect.fail(`expected AppletTemplateError '${code}'`);
}

describe('materializeAppletTemplatePatch', () => {
  it('substitutes valueFrom with the input value unchanged', () => {
    const result = materializeAppletTemplatePatch(
      [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }],
      { amount: 40000 },
    );
    expect(result).toEqual([{ op: 'replace', path: '/state/budget', value: 40000 }]);
    expect(typeof result[0]?.value).toBe('number');
  });

  it('never coerces — a string stays a string', () => {
    const result = materializeAppletTemplatePatch(
      [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }],
      { amount: '40000' },
    );
    expect(result[0]?.value).toBe('40000');
  });

  it('materializes pathTemplate segments with RFC 6901 escaping', () => {
    const result = materializeAppletTemplatePatch(
      [
        {
          op: 'replace',
          pathTemplate: ['/state/tasks', { from: '/input/taskId' }, 'owner'],
          valueFrom: '/input/owner',
        },
      ],
      { taskId: 'a/b~c', owner: 'sara' },
    );
    expect(result).toEqual([{ op: 'replace', path: '/state/tasks/a~1b~0c/owner', value: 'sara' }]);
  });

  it('accepts a non-negative integer as a path segment', () => {
    const result = materializeAppletTemplatePatch(
      [{ op: 'remove', pathTemplate: ['/state/tasks', { from: '/input/index' }] }],
      { index: 3 },
    );
    expect(result).toEqual([{ op: 'remove', path: '/state/tasks/3' }]);
  });

  it('refuses a non-token path segment', () => {
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'remove', pathTemplate: ['/state/tasks', { from: '/input/bad' }] }],
          { bad: { nested: true } },
        ),
      'segment_not_a_token',
    );
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'remove', pathTemplate: ['/state/tasks', { from: '/input/frac' }] }],
          { frac: 1.5 },
        ),
      'segment_not_a_token',
    );
  });

  it('refuses a missing input value for both valueFrom and path segments', () => {
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'replace', path: '/state/budget', valueFrom: '/input/absent' }],
          {},
        ),
      'missing_input_value',
    );
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'remove', pathTemplate: ['/state/tasks', { from: '/input/absent' }] }],
          {},
        ),
      'missing_input_value',
    );
  });

  it('carries a baked literal value, cloned rather than aliased', () => {
    const literal = { done: true };
    const template: AppletTemplatePatchOp[] = [{ op: 'add', path: '/state/flags', value: literal }];
    const result = materializeAppletTemplatePatch(template, {});
    expect(result[0]?.value).toEqual({ done: true });
    expect(result[0]?.value).not.toBe(literal);
  });

  it('clones values resolved from input', () => {
    const input = { settings: { theme: 'dark' } };
    const result = materializeAppletTemplatePatch(
      [{ op: 'add', path: '/state/settings', valueFrom: '/input/settings' }],
      input,
    );
    expect(result[0]?.value).toEqual({ theme: 'dark' });
    expect(result[0]?.value).not.toBe(input.settings);
  });

  it('refuses a materialized pointer beyond the length cap', () => {
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'remove', pathTemplate: ['/state/tasks', { from: '/input/id' }] }],
          { id: 'x'.repeat(600) },
        ),
      'materialized_path_too_long',
    );
  });

  it('refuses malformed template shapes defensively', () => {
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [
            {
              op: 'replace',
              path: '/state/a',
              pathTemplate: ['/state/a'],
              value: 1,
            } as AppletTemplatePatchOp,
          ],
          {},
        ),
      'template_shape',
    );
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [{ op: 'remove', path: '/state/a', value: 1 } as AppletTemplatePatchOp],
          {},
        ),
      'template_shape',
    );
    expectTemplateError(
      () =>
        materializeAppletTemplatePatch(
          [
            {
              op: 'replace',
              path: '/state/a',
              value: 1,
              valueFrom: '/input/a',
            } as AppletTemplatePatchOp,
          ],
          { a: 1 },
        ),
      'template_shape',
    );
    expectTemplateError(
      () => materializeAppletTemplatePatch([{ op: 'replace', path: '/state/a' }], {}),
      'template_shape',
    );
  });
});
