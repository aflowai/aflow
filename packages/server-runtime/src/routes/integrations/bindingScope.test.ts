/**
 * A binding's stored scope is the request's own identity, plus the one member the
 * caller owns.
 *
 * Two failures live here and only one is loud. A schema that still demands a
 * tenant the client has stopped sending rejects the request before any handler
 * runs, so no amount of correct composition helps. A composition that drops
 * `flowId` succeeds, and silently grants a flow-scoped binding to the whole
 * space — both upserts write `scope_json = EXCLUDED.scope_json`, so the stored
 * narrowing is replaced rather than left alone.
 *
 * Asserted against the exports the routes themselves use: a reconstructed copy
 * of the schema would let either side drift while staying green.
 */
import { describe, expect, it } from 'vitest';

import { McpServerBindingSchema } from '@aflow/schemas';

import {
  RequestBindingScopeSchema,
  composeStoredBindingScope,
  statedBindingScope,
} from './bindingScope.js';

const IDENTITY = { tenantId: 'tenant-1', spaceId: 'space-1' };

describe('what a binding request may state about its scope', () => {
  it('accepts a scope that names no tenant', () => {
    const parsed = RequestBindingScopeSchema.safeParse({});
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('keeps an absent scope absent, rather than defaulting it to a statement', () => {
    const parsed = RequestBindingScopeSchema.safeParse(undefined);
    expect(parsed.success && parsed.data).toBeUndefined();
  });

  /**
   * The executor scores a binding on a *truthy* `flowId`, so an empty one reads
   * as no flow and the binding is chosen by its space instead — a request asking
   * to narrow would instead be granted the whole space, silently.
   */
  it('refuses an empty flow rather than storing one that reads as absent', () => {
    const parsed = RequestBindingScopeSchema.safeParse({ flowId: '' });
    expect(parsed.success).toBe(false);
  });

  it('keeps a flow the caller narrowed the binding to', () => {
    const parsed = RequestBindingScopeSchema.safeParse({ flowId: 'flow-7' });
    expect(parsed.success && parsed.data).toEqual({ flowId: 'flow-7' });
  });

  // The stored model still requires a tenant, which is right — a stored binding
  // always belongs to one. Only the request may omit it.
  it('still requires a tenant in the stored shape', () => {
    const stored = McpServerBindingSchema.safeParse({
      bindingId: 'b1',
      serverId: 's1',
      name: 'A server',
      auth: { type: 'none' },
      scope: {},
      connectionPolicy: {},
    });
    expect(stored.success).toBe(false);
  });
});

describe('what gets stored', () => {
  it('stamps the identity the caller could not state', () => {
    expect(composeStoredBindingScope({}, IDENTITY)).toEqual({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });

  it('carries the flow through, rather than widening the binding to the space', () => {
    expect(composeStoredBindingScope({ flowId: 'flow-7' }, IDENTITY)).toEqual({
      flowId: 'flow-7',
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });

  it('cannot be talked out of its own identity', () => {
    const claimed = RequestBindingScopeSchema.parse({
      flowId: 'flow-7',
      tenantId: 'someone-elses-tenant',
      spaceId: 'someone-elses-space',
    });
    expect(composeStoredBindingScope(claimed, IDENTITY)).toEqual({
      flowId: 'flow-7',
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });
});

describe('the routes use this contract rather than their own copy', () => {
  it('is what both upserts import', async () => {
    const [mcp, api] = await Promise.all([
      import('node:fs').then((fs) =>
        fs.readFileSync(new URL('./mcp-bindings.ts', import.meta.url), 'utf8'),
      ),
      import('node:fs').then((fs) =>
        fs.readFileSync(new URL('./bindings.ts', import.meta.url), 'utf8'),
      ),
    ]);
    for (const [name, src] of [
      ['mcp-bindings.ts', mcp],
      ['bindings.ts', api],
    ] as const) {
      // At the call sites, not merely imported: an unused import satisfies a
      // `toContain` on the bare name, which is how a copy of this schema sat in
      // both routes with the shared one imported above it.
      expect(src, `${name} does not take the shared request scope`).toContain(
        'scope: RequestBindingScopeSchema',
      );
      expect(src, `${name} composes its stored scope by hand`).toContain(
        'composeStoredBindingScope(body.scope',
      );
      expect(src, `${name} keeps its own copy of the request scope`).not.toContain(
        'scope: z.object({ flowId',
      );
    }
  });
});

describe('an update that says nothing about scope', () => {
  // These routes already preserve auth, egress, fulfillment and variable values
  // on omission. Scope was the one column that did not, so renaming a binding or
  // rotating its credentials replaced a flow-scoped binding with a space-wide one.
  it('writes nothing, so the stored narrowing survives', () => {
    expect(statedBindingScope(undefined, IDENTITY)).toBeNull();
  });

  it('is not the same as stating an empty scope', () => {
    expect(statedBindingScope({}, IDENTITY)).toEqual({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });

  it('still creates a row with its identity stamped', () => {
    expect(composeStoredBindingScope(undefined, IDENTITY)).toEqual({
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });

  it('writes the flow when one is stated', () => {
    expect(statedBindingScope({ flowId: 'flow-7' }, IDENTITY)).toEqual({
      flowId: 'flow-7',
      tenantId: 'tenant-1',
      spaceId: 'space-1',
    });
  });
});

describe('the upserts preserve rather than overwrite', () => {
  it('coalesces to the stored column instead of taking EXCLUDED outright', async () => {
    const fs = await import('node:fs');
    for (const [name, table] of [
      ['mcp-bindings.ts', 'mcp_server_bindings'],
      ['bindings.ts', 'api_bindings'],
    ] as const) {
      const src = fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
      expect(src, `${name} overwrites scope_json on every update`).not.toContain(
        'scope_json = EXCLUDED.scope_json',
      );
      expect(src, `${name} does not fall back to its stored scope`).toContain(
        `${table}.scope_json`,
      );
    }
  });
});
