/**
 * The dispatch outbox that makes a schedule fire once.
 *
 * A schedule's occurrence lives in two stores: the tenant row that says when it
 * next fires, and the control message that actually starts the run. Advancing
 * the row and emitting the message cannot both be atomic, so one of them has to
 * become re-drivable — and it cannot be the schedule row, because the advance is
 * precisely what stops it being due. An outbox row written in the same
 * transaction as the advance is the re-drivable half: after the commit the
 * occurrence exists exactly once, durably, whether or not anything has been
 * emitted for it yet.
 *
 * That gives both halves of "once". Not twice: the advance and the insert share
 * a transaction, so a crash before commit leaves the schedule due with no row,
 * and the retry recomputes the same `firing_count` and therefore the same key.
 * Not zero: the row outlives the advance, and the drain deletes it only after
 * the control message is durably written.
 *
 * The drain is at-least-once by construction — it can be killed between the
 * emit and the delete — so it claims the same `start_run` idempotency key the
 * other producers claim before enqueueing. A redelivery then finds the claim
 * taken and drops the row instead of starting a second run.
 */

export const SCHEDULE_DISPATCH_OUTBOX_TABLE = 'public.schedule_dispatch_outbox';

export function scheduleDispatchOutboxDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${SCHEDULE_DISPATCH_OUTBOX_TABLE} (
      -- The occurrence's identity, not the row's: (schedule, firing count) is
      -- what "this occurrence" means, and it is the same key the control-message
      -- seam dedupes on. A surrogate id would let one occurrence enter twice.
      idempotency_key TEXT PRIMARY KEY,
      tenant_id       UUID NOT NULL,
      schedule_id     UUID NOT NULL,
      dispatch        JSONB NOT NULL,
      attempts        INT NOT NULL DEFAULT 0,
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Also the retry backoff: a failed drain pushes the lease out rather than
      -- deleting the row, so the occurrence comes back without a second index.
      lease_until     TIMESTAMPTZ,
      claimed_by      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_dispatch_outbox_ready
      ON ${SCHEDULE_DISPATCH_OUTBOX_TABLE} (created_at)
      WHERE claimed_by IS NULL;
  `;
}
