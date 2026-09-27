/**
 * Tenant-bound payload reads.
 *
 * A payload ref is data, never authority: it arrives on operation input the
 * agent wrote, and every backend resolves it against one configured bucket. A
 * ref naming another tenant's object path would therefore be served as readily
 * as the caller's own, so the tenant segment is compared against the tenant the
 * job runs as before the store is asked. The comparison is syntactic, so a
 * refusal discloses nothing about whether the object exists.
 */
import { parsePayloadRef, type AflowError, type PayloadRef, type TenantId } from '@aflow/schemas';
import type { PayloadStore } from '@aflow/payload-store';

export class PayloadAccessError extends Error {
  constructor(
    message: string,
    private readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PayloadAccessError';
  }

  toAflowError(): AflowError {
    return {
      code: 'PERMISSION_DENIED',
      message: this.message,
      classification: 'permission',
      retryable: false,
      timestamp: new Date().toISOString(),
      details: this.details,
    };
  }
}

/**
 * Throws when `ref` parses and names a tenant other than `tenantId`. Both stored
 * layouts name the owning tenant — the run-scoped one also names a run, the
 * content-addressed one names only a content hash — so the tenant segment is the
 * one field both carry. The run is deliberately not compared even where a ref
 * names one: one run reads another's outputs (a parent reads its child's, a
 * retry reads the attempt before it), and those stay within the tenant.
 *
 * Binding is the whole job. Whether a ref is well formed is the store's
 * question, and answering it here too is what turned an unrecognised shape into
 * a permission error on a path that had nothing to do with tenancy.
 */
export function assertPayloadRefTenant(ref: PayloadRef, tenantId: TenantId): void {
  const parsed = parsePayloadRef(ref);

  // A ref this cannot parse is not evidence of a cross-tenant read, and it is
  // not this function's question. Canonicality belongs to the store, which
  // refuses an unusable ref on its own before any object is addressed — so
  // rejecting here as well put the same rule in two places and made the
  // stricter one reject shapes the store would have handled.
  if (!parsed) return;

  // An inline ref carries its own bytes: reading it returns what the caller
  // supplied, and no stored object is reachable through it.
  if (parsed.form === 'inline') return;

  if (parsed.tenantId !== tenantId) {
    throw new PayloadAccessError(
      'Payload reference belongs to another tenant. Pass a ref this run produced or a ' +
        'pinned memory reference.',
      { ref },
    );
  }
}

export async function retrievePayloadForTenant(args: {
  payloadStore: PayloadStore;
  ref: PayloadRef;
  tenantId: TenantId;
}): Promise<unknown> {
  assertPayloadRefTenant(args.ref, args.tenantId);
  return await args.payloadStore.retrieve(args.ref);
}
