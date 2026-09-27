/**
 * Surface Binding Contract Tests
 *
 * Validates that the surface catalog, component schemas, and store are
 * consistent — specifically that bindable components can resolve data of
 * any JSON-primitive type (string, number, boolean, null, object, array).
 *
 * These tests catch the class of bug where:
 * - A catalog entry declares bindingKeys but the schema doesn't accept them
 * - Bound data of a valid JSON type (e.g., number) is silently dropped
 * - The store fails to resolve bindings at nested JSON Pointer paths
 */
import { describe, it, expect } from 'vitest';
import {
  SURFACE_CATALOG,
  SurfaceComponentTypeSchema,
  type SurfaceCatalogEntry,
} from '@aflow/schemas';
import { surfaceComponentPropSchemas } from '@aflow/schemas';
import { SurfaceStore, getAtPointer, setAtPointer } from '../store.js';

// =============================================================================
// 1. Catalog ↔ Schema alignment
// =============================================================================

describe('Catalog ↔ Schema alignment', () => {
  const catalogComponents = SURFACE_CATALOG.map((c) => c.component);
  const schemaComponents = Object.keys(surfaceComponentPropSchemas);
  const typeEnumValues = SurfaceComponentTypeSchema.options;

  it('every catalog component has a matching Zod prop schema', () => {
    for (const name of catalogComponents) {
      expect(schemaComponents).toContain(name);
    }
  });

  it('every Zod prop schema has a matching catalog entry', () => {
    for (const name of schemaComponents) {
      expect(catalogComponents).toContain(name);
    }
  });

  it('every catalog component is in the SurfaceComponentType enum', () => {
    for (const name of catalogComponents) {
      expect(typeEnumValues).toContain(name);
    }
  });

  it('catalog, schema map, and type enum all have the same count', () => {
    expect(catalogComponents.length).toBe(schemaComponents.length);
    expect(catalogComponents.length).toBe(typeEnumValues.length);
  });
});

// =============================================================================
// 2. Binding keys declared in catalog exist as valid prop names in schemas
// =============================================================================

describe('Catalog bindingKeys ↔ component prop schemas', () => {
  const bindableEntries = SURFACE_CATALOG.filter(
    (c): c is SurfaceCatalogEntry & { bindingKeys: readonly string[] } =>
      c.bindable === true && c.bindingKeys != null && c.bindingKeys.length > 0,
  );

  it('has at least 5 bindable components (sanity check)', () => {
    expect(bindableEntries.length).toBeGreaterThanOrEqual(5);
  });

  for (const entry of bindableEntries) {
    describe(`${entry.component}`, () => {
      it(`declares bindingKeys: [${entry.bindingKeys.join(', ')}]`, () => {
        expect(entry.bindingKeys.length).toBeGreaterThan(0);
      });

      it('each bindingKey is also listed in the catalog props (or is a known virtual key)', () => {
        // Virtual keys are binding-only — they don't appear in static props.
        // "text" is a virtual key for Heading/Text (content is in props, text is the binding key).
        // "message" is virtual for ChatComposer. "value" is virtual for Field (bindPath is the prop).
        const virtualKeys = new Set(['text', 'message', 'value']);
        const propNames = new Set(entry.props.map((p) => p.name));

        for (const key of entry.bindingKeys) {
          const isInProps = propNames.has(key);
          const isVirtual = virtualKeys.has(key);
          expect(
            isInProps || isVirtual,
            `${entry.component}: bindingKey "${key}" is neither in props nor a known virtual key`,
          ).toBe(true);
        }
      });
    });
  }
});

// =============================================================================
// 3. Store resolves bound data of all JSON primitive types
// =============================================================================

describe('SurfaceStore data model resolution', () => {
  const testCases: Array<{ label: string; pointer: string; value: unknown }> = [
    { label: 'string', pointer: '/name', value: 'Alice' },
    { label: 'number (integer)', pointer: '/score', value: 82 },
    { label: 'number (float)', pointer: '/rate', value: 3.14 },
    { label: 'number (zero)', pointer: '/zero', value: 0 },
    { label: 'boolean (true)', pointer: '/active', value: true },
    { label: 'boolean (false)', pointer: '/disabled', value: false },
    { label: 'null', pointer: '/empty', value: null },
    { label: 'array', pointer: '/items', value: [1, 2, 3] },
    { label: 'object', pointer: '/config', value: { key: 'val' } },
    { label: 'nested path', pointer: '/lead/company/name', value: 'Henkel' },
  ];

  for (const { label, pointer, value } of testCases) {
    it(`resolves ${label} at ${pointer}`, () => {
      const store = new SurfaceStore();
      store.apply({
        type: 'createSurface',
        surfaceId: 'test',
        messageId: 'm1',
        catalogVersion: 'v1',
        timestamp: new Date().toISOString(),
        dataModel: { [pointer]: value },
      });

      expect(store.getData(pointer)).toEqual(value);
    });
  }

  it('resolves nested pointer after setAtPointer', () => {
    let dm: Record<string, unknown> = {};
    dm = setAtPointer(dm, '/lead/company', 'Henkel');
    dm = setAtPointer(dm, '/lead/score', 82);

    expect(getAtPointer(dm, '/lead/company')).toBe('Henkel');
    expect(getAtPointer(dm, '/lead/score')).toBe(82);
    expect(getAtPointer(dm, '/lead')).toEqual({ company: 'Henkel', score: 82 });
  });

  it('returns undefined for missing paths', () => {
    const dm: Record<string, unknown> = { name: 'Alice' };
    expect(getAtPointer(dm, '/missing')).toBeUndefined();
    expect(getAtPointer(dm, '/deep/nested/path')).toBeUndefined();
  });
});

// =============================================================================
// 4. Pre-loaded data injection into createSurface
// =============================================================================

describe('Pre-loaded data injection', () => {
  it('createSurface dataModel merges pre-loaded and model data', () => {
    const store = new SurfaceStore();
    const preloaded = { '/leads': [{ name: 'A' }], '/score': 82 };
    const modelData = { '/title': 'Dashboard' };

    store.apply({
      type: 'createSurface',
      surfaceId: 'test',
      messageId: 'm1',
      catalogVersion: 'v1',
      timestamp: new Date().toISOString(),
      dataModel: { ...preloaded, ...modelData },
    });

    expect(store.getData('/leads')).toEqual([{ name: 'A' }]);
    expect(store.getData('/score')).toBe(82);
    expect(store.getData('/title')).toBe('Dashboard');
  });

  it('model data takes precedence over pre-loaded data at same path', () => {
    const store = new SurfaceStore();
    const preloaded = { '/score': 82 };
    const modelData = { '/score': 95 };

    store.apply({
      type: 'createSurface',
      surfaceId: 'test',
      messageId: 'm1',
      catalogVersion: 'v1',
      timestamp: new Date().toISOString(),
      dataModel: { ...preloaded, ...modelData },
    });

    expect(store.getData('/score')).toBe(95);
  });

  it('updateDataModel adds to existing data without losing other keys', () => {
    const store = new SurfaceStore();

    store.apply({
      type: 'createSurface',
      surfaceId: 'test',
      messageId: 'm1',
      catalogVersion: 'v1',
      timestamp: new Date().toISOString(),
      dataModel: { '/score': 82, '/name': 'Alice' },
    });

    store.apply({
      type: 'updateDataModel',
      surfaceId: 'test',
      messageId: 'm2',
      catalogVersion: 'v1',
      timestamp: new Date().toISOString(),
      dataModel: { '/tier': 'Hot' },
    });

    expect(store.getData('/score')).toBe(82);
    expect(store.getData('/name')).toBe('Alice');
    expect(store.getData('/tier')).toBe('Hot');
  });
});

// =============================================================================
// 5. Binding key coverage — every bindable component type has test coverage
// =============================================================================

describe('Binding coverage audit', () => {
  const bindableComponents = SURFACE_CATALOG.filter((c) => c.bindable);

  it('lists all bindable components for reference', () => {
    const names = bindableComponents.map((c) => `${c.component}(${c.bindingKeys?.join(',')})`);
    // This test always passes — it's a living inventory in test output
    expect(names.length).toBeGreaterThan(0);
  });

  // Verify that binding keys used in practice match catalog declarations
  const knownBindingUsages: Record<string, string[]> = {
    Heading: ['text'],
    Text: ['text'],
    MetricGrid: ['items'],
    DataTable: ['rows', 'columns'],
    List: ['items'],
    Field: ['value'],
    Chart: ['data'],
    ChatComposer: ['message'],
    Image: ['src'],
    CodeBlock: ['code'],
    Badge: ['label'],
  };

  for (const [component, expectedKeys] of Object.entries(knownBindingUsages)) {
    it(`${component} catalog bindingKeys includes ${expectedKeys.join(', ')}`, () => {
      const entry = SURFACE_CATALOG.find((c) => c.component === component);
      expect(entry, `${component} not found in catalog`).toBeDefined();
      expect(entry!.bindable).toBe(true);
      for (const key of expectedKeys) {
        expect(entry!.bindingKeys, `${component} missing bindingKeys`).toBeDefined();
        expect(entry!.bindingKeys!, `${component} bindingKeys missing "${key}"`).toContain(key);
      }
    });
  }
});
