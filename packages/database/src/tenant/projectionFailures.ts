/**
 * The durable record of a session Postgres could not be told about.
 *
 * The projection candidate index is the worklist for sessions that still have a
 * path to Postgres. This table is for the ones that no longer do: a candidate
 * dropped after repeated failures, or one whose hot state is gone before it was
 * ever flushed. Both leave a stale — or absent — durable row with nothing
 * pointing at it, and a log line is not a record: it rotates, it cannot be
 * counted, and it cannot be queried per session.
 *
 * A row keyed by the session rather than by a fingerprint, because the question
 * an operator asks here is "which sessions are stale", and a grouping surface
 * answers a different one. `attempts` lives on the row rather than in the
 * worker, so the ceiling survives a restart and means the same thing on one
 * instance as on five — a process-local counter is reset by a deploy and
 * duplicated by an overlap, so the threshold is a number nobody can reason
 * about.
 *
 * Public rather than per-tenant: the worker holds a tenant id and nothing else,
 * and opening the tenant schema is frequently the very operation that just
 * failed.
 */

export const PROJECTION_FAILURES_TABLE = 'public.projection_failures';

export function projectionFailuresDdl(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${PROJECTION_FAILURES_TABLE} (
      tenant_id       UUID NOT NULL,
      session_id      UUID NOT NULL,
      -- Why the durable copy is behind: repeated projection failures, or hot
      -- state that expired or was quarantined before it was ever flushed. Kept
      -- distinct because they need different operator responses — a retry helps
      -- one and cannot help the other.
      reason          TEXT NOT NULL,
      attempts        INT NOT NULL DEFAULT 0,
      last_error      TEXT,
      -- Set when the candidate was dropped. Until then the session is still
      -- armed and this row is a warning; after it, nothing else points at the
      -- session and this row is the only thing that does.
      evicted_at      TIMESTAMPTZ,
      first_failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_projection_failures_evicted
      ON ${PROJECTION_FAILURES_TABLE} (last_failed_at)
      WHERE evicted_at IS NOT NULL;
  `;
}
