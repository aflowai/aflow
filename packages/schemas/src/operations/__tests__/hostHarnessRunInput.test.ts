import { describe, expect, it } from 'vitest';
import {
  HostFilePatchInputSchema,
  HostFilePatchOutputSchema,
  HostHarnessRunInputSchema,
} from '../host.js';
import { toJsonSchemaSync } from '../../utils/jsonSchema.js';

const base = { bindingId: 'hb_x', task: 'Review the range.' };

describe('host.harness.run takes its object arguments however the caller spelled them', () => {
  it('parses a JSON-stringified outputSchema and inputs back to objects', () => {
    const parsed = HostHarnessRunInputSchema.parse({
      ...base,
      outputSchema: '{"type":"object","required":["verdict"]}',
      inputs: '{"range":"main..HEAD"}',
    });
    expect(parsed.outputSchema).toEqual({ type: 'object', required: ['verdict'] });
    expect(parsed.inputs).toEqual({ range: 'main..HEAD' });
  });

  it('takes the object forms unchanged and leaves an absent field absent', () => {
    const parsed = HostHarnessRunInputSchema.parse({ ...base, outputSchema: { type: 'object' } });
    expect(parsed.outputSchema).toEqual({ type: 'object' });
    expect(parsed.inputs).toBeUndefined();
  });

  it('still refuses a string that is not JSON as the object it is not', () => {
    const result = HostHarnessRunInputSchema.safeParse({ ...base, outputSchema: 'a schema' });
    expect(result.success).toBe(false);
  });

  it('describes the fields to a caller as objects, with their descriptions', () => {
    const json = toJsonSchemaSync(HostHarnessRunInputSchema) as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(json.properties['outputSchema']?.type).toBe('object');
    expect(json.properties['outputSchema']?.description).toContain('JSON Schema');
    expect(json.properties['inputs']?.type).toBe('object');
  });
});

describe('a commission and a publication name the commit they start from', () => {
  it('takes a branch, a tag or a sha as the base of a run, and leaves it absent otherwise', () => {
    for (const ref of ['feat/fix-the-parser', 'v1.2.0', 'a1b2c3d', 'a'.repeat(40)]) {
      expect(HostHarnessRunInputSchema.parse({ ...base, base: ref }).base).toBe(ref);
    }
    expect(HostHarnessRunInputSchema.parse(base).base).toBeUndefined();
  });

  it('refuses a base that would read as an option, split, or climb', () => {
    for (const ref of ['', '--output=/tmp/x', 'two words', 'a..b', 'x'.repeat(201)]) {
      expect(HostHarnessRunInputSchema.safeParse({ ...base, base: ref }).success).toBe(false);
    }
  });

  it('carries a base on a commit, under the same rule', () => {
    const patch = { bindingId: 'hb_x', patch: 'diff --git a/x b/x\n' };
    const parsed = HostFilePatchInputSchema.parse({
      ...patch,
      commit: { branch: 'aflow/fix', message: 'Fix', base: 'a'.repeat(40) },
    });
    expect(parsed.commit?.base).toBe('a'.repeat(40));
    expect(
      HostFilePatchInputSchema.safeParse({
        ...patch,
        commit: { branch: 'aflow/fix', message: 'Fix', base: '-x' },
      }).success,
    ).toBe(false);
  });

  it('says whether a commit was appended', () => {
    const commit = { branch: 'aflow/fix', sha: 'b'.repeat(40), baseSha: 'a'.repeat(40) };
    const result = { state: 'applied', filesChanged: 1, files: ['x'], conflicts: [] };
    expect(
      HostFilePatchOutputSchema.safeParse({ ...result, commit: { ...commit, appended: true } })
        .success,
    ).toBe(true);
    expect(HostFilePatchOutputSchema.safeParse({ ...result, commit }).success).toBe(false);
  });
});
