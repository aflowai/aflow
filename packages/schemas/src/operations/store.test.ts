import { describe, it, expect } from 'vitest';
import { buildOperationId } from '../catalog/operationId.js';
import { getAllOperationIds, getOperation } from '../catalog/registry.js';
import { StepTypeSchema } from '../artifact/operationDefinition.js';
import {
  StoreListingOperationRegistrations,
  StoreListingSearchInputSchema,
  StoreListingGetInputSchema,
  StoreListingInstallInputSchema,
} from './store.js';

const EXPECTED_OPERATION_IDS = [
  'store.listing.search',
  'store.listing.get',
  'store.listing.install',
];

describe('store.listing.* registrations', () => {
  it('derives the expected operationIds structurally', () => {
    const ids = StoreListingOperationRegistrations.map((reg) =>
      buildOperationId(reg.stepType, reg.group, reg.verb),
    );
    expect(ids).toEqual(EXPECTED_OPERATION_IDS);
  });

  it('uses a stepType the platform enum accepts', () => {
    for (const reg of StoreListingOperationRegistrations) {
      expect(StepTypeSchema.safeParse(reg.stepType).success).toBe(true);
    }
  });

  it('classifies discovery as read/idempotent and install as a write proposal', () => {
    const byVerb = new Map(StoreListingOperationRegistrations.map((reg) => [reg.verb, reg]));

    for (const verb of ['search', 'get'] as const) {
      const reg = byVerb.get(verb);
      expect(reg?.accessMode).toBe('read');
      expect(reg?.idempotency).toBe('idempotent');
      expect(reg?.mutates).toBe(false);
    }

    const install = byVerb.get('install');
    expect(install?.accessMode).toBe('write');
    expect(install?.idempotency).toBe('non_idempotent');
    expect(install?.mutates).toBe(true);
  });

  it('parses each minimalExampleInput against its inputZod', () => {
    for (const reg of StoreListingOperationRegistrations) {
      const result = reg.inputZod.safeParse(reg.usage.minimalExampleInput);
      expect(result.success).toBe(true);
    }
  });

  it('is wired into the live registry under the store.listing capability group', () => {
    const liveIds = getAllOperationIds();
    for (const operationId of EXPECTED_OPERATION_IDS) {
      expect(liveIds).toContain(operationId);
      const descriptor = getOperation(operationId);
      expect(descriptor?.operationId).toBe(operationId);
      expect(descriptor?.capabilityGroupId).toBe('store.listing');
    }
    expect(getOperation('store.listing.search')?.accessMode).toBe('read');
    expect(getOperation('store.listing.get')?.accessMode).toBe('read');
    expect(getOperation('store.listing.install')?.accessMode).toBe('write');
  });
});

describe('store.listing.search input', () => {
  it('accepts an empty input and applies the maxResults default', () => {
    const result = StoreListingSearchInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxResults).toBe(5);
    }
  });

  it('accepts query, kind, and maxResults together', () => {
    const result = StoreListingSearchInputSchema.safeParse({
      query: 'jira',
      kind: 'connector',
      maxResults: 10,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an out-of-range maxResults and an unknown kind', () => {
    expect(StoreListingSearchInputSchema.safeParse({ maxResults: 0 }).success).toBe(false);
    expect(StoreListingSearchInputSchema.safeParse({ maxResults: 11 }).success).toBe(false);
    expect(StoreListingSearchInputSchema.safeParse({ kind: 'workflow' }).success).toBe(false);
  });
});

describe('store.listing.get input', () => {
  it('accepts a valid catalogId', () => {
    expect(StoreListingGetInputSchema.safeParse({ catalogId: 'jira' }).success).toBe(true);
  });

  it('rejects a missing or malformed catalogId', () => {
    expect(StoreListingGetInputSchema.safeParse({}).success).toBe(false);
    expect(StoreListingGetInputSchema.safeParse({ catalogId: 'Not Valid' }).success).toBe(false);
  });
});

describe('store.listing.install input', () => {
  it('accepts a catalogId with a positive integer expectedVersion', () => {
    const result = StoreListingInstallInputSchema.safeParse({
      catalogId: 'jira',
      expectedVersion: 3,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing or non-positive expectedVersion', () => {
    expect(StoreListingInstallInputSchema.safeParse({ catalogId: 'jira' }).success).toBe(false);
    expect(
      StoreListingInstallInputSchema.safeParse({ catalogId: 'jira', expectedVersion: 0 }).success,
    ).toBe(false);
    expect(
      StoreListingInstallInputSchema.safeParse({ catalogId: 'jira', expectedVersion: 1.5 }).success,
    ).toBe(false);
  });
});
