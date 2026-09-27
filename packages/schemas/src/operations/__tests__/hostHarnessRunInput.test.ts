import { describe, expect, it } from 'vitest';
import { HostHarnessRunInputSchema } from '../host.js';
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
