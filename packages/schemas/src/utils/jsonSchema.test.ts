/**
 * Converting a Zod schema is the expensive half of building the catalog, and
 * its result is fixed for a given (schema, options) — so it is cached. What
 * makes that safe is that callers get a copy: `buildCoreToolSpec` deletes the
 * internal fields out of what it receives while catalog search reads the same
 * properties, so a shared instance would let one caller's pruning decide what
 * the other one sees. These pin the copy, not just the cache.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('zod-to-json-schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zod-to-json-schema')>();
  return { ...actual, zodToJsonSchema: vi.fn(actual.zodToJsonSchema) };
});

/**
 * A module graph built after the mock, with an empty cache.
 *
 * Both matter: the conversion cache lives for the life of the module, so tests
 * that count conversions have to start from a cold one — and the module has to
 * be evaluated here rather than at import time, or a sibling test file that
 * loaded it first leaves this one counting calls into the real library.
 */
async function freshModule() {
  vi.resetModules();
  const { zodToJsonSchema } = await import('zod-to-json-schema');
  const { toJsonSchemaSync } = await import('./jsonSchema.js');
  const convert = vi.mocked(zodToJsonSchema);
  convert.mockClear();
  return { toJsonSchemaSync, convert };
}

const makeSchema = (): z.ZodType =>
  z.object({ keep: z.string().describe('kept'), internal: z.string() });

describe('toJsonSchemaSync caching', () => {
  it('converts a given schema once however often it is asked for', async () => {
    const { toJsonSchemaSync, convert } = await freshModule();
    const schema = makeSchema();

    toJsonSchemaSync(schema);
    toJsonSchemaSync(schema);
    toJsonSchemaSync(schema);

    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('still converts again when the options change the output', async () => {
    const { toJsonSchemaSync, convert } = await freshModule();
    const schema = makeSchema();

    toJsonSchemaSync(schema);
    toJsonSchemaSync(schema, { title: 'Named' });
    toJsonSchemaSync(schema, { draft: 'draft-07' });

    expect(convert).toHaveBeenCalledTimes(3);
  });

  it('never hands two callers the same object', async () => {
    const { toJsonSchemaSync } = await freshModule();
    const schema = makeSchema();
    expect(toJsonSchemaSync(schema)).not.toBe(toJsonSchemaSync(schema));
  });

  it('survives the caller that populated the cache mutating its result', async () => {
    // Exactly what buildCoreToolSpec does to strip internal inputs — on the
    // call that MISSED, so this pins the copy handed out when storing.
    const { toJsonSchemaSync } = await freshModule();
    const schema = makeSchema();

    const first = toJsonSchemaSync(schema) as Record<string, unknown>;
    delete (first['properties'] as Record<string, unknown>)['internal'];

    const later = toJsonSchemaSync(schema) as Record<string, unknown>;

    expect(Object.keys(later['properties'] as Record<string, unknown>)).toContain('internal');
  });

  it('survives a later caller mutating what the cache handed back', async () => {
    // The other half, and the one a store-path copy alone does not cover: this
    // mutates a result that came from a HIT, so only copying on the way out of
    // the cache keeps the third caller whole.
    const { toJsonSchemaSync } = await freshModule();
    const schema = makeSchema();
    toJsonSchemaSync(schema);

    const fromCache = toJsonSchemaSync(schema) as Record<string, unknown>;
    delete (fromCache['properties'] as Record<string, unknown>)['internal'];

    const third = toJsonSchemaSync(schema) as Record<string, unknown>;

    expect(Object.keys(third['properties'] as Record<string, unknown>)).toContain('internal');
  });

  it('keeps nested objects out of the shared copy too', async () => {
    // A shallow copy would still let a caller reach the cached properties map.
    const { toJsonSchemaSync } = await freshModule();
    const schema = z.object({ outer: z.object({ inner: z.string() }) });
    toJsonSchemaSync(schema);

    const first = toJsonSchemaSync(schema) as Record<string, unknown>;
    const props = first['properties'] as Record<string, Record<string, unknown>>;
    (props['outer'] as Record<string, unknown>)['description'] = 'mutated';

    const second = toJsonSchemaSync(schema) as Record<string, unknown>;
    const secondProps = second['properties'] as Record<string, Record<string, unknown>>;

    expect(secondProps['outer']?.['description']).toBeUndefined();
  });

  it('returns the same content it would have without a cache', async () => {
    const { toJsonSchemaSync } = await freshModule();
    const { zodToJsonSchema: real } =
      await vi.importActual<typeof import('zod-to-json-schema')>('zod-to-json-schema');
    const schema = makeSchema();

    expect(toJsonSchemaSync(schema)).toEqual(real(schema, { $refStrategy: 'none' }));
  });
});
