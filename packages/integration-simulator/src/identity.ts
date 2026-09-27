import { createHash } from 'node:crypto';

/**
 * Deterministic id minting.
 *
 * Derived from `(seed, logicalExecutionId, collection, sequence)`: the same
 * call, replayed, mints the same ids, and a random or time-based id would make
 * every run's world differ in the field every other entity references.
 *
 * Keyed on the CALL rather than on the world version it was going to commit at.
 * That version had to be reserved before the ladder ran purely so ids could be
 * minted from it — which forced every call to claim a slot in advance, and the
 * whole scheduled-ordering apparatus existed to decide which slot. A call's own
 * logical id is just as stable and settles nothing about order, so versions can
 * now be assigned where they belong: at commit, in the order commits happen.
 */
export function mintEntityId(params: {
  seed: string;
  logicalExecutionId: string;
  collection: string;
  sequence: number;
}): string {
  // NUL-separated, not space-separated. A logical execution id and a seed are
  // both opaque strings that may contain a space, and a space separator lets
  // ("a", "b c") and ("a b", "c") hash to the same id — two different calls
  // minting one entity id, which the world would then treat as one row.
  const digest = createHash('sha256')
    .update(
      [params.seed, params.logicalExecutionId, params.collection, String(params.sequence)].join(
        '\u0000',
      ),
      'utf8',
    )
    .digest('hex');
  return `${params.collection}_${digest.slice(0, 20)}`;
}

/**
 * The default seed for a run that pins none. Derived from the run id so two
 * runs explore differently while either can be replayed by pinning its seed.
 */
export function deriveRunSeed(runId: string): string {
  return createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 32);
}
