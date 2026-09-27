/**
 * Durable record of provider-side asynchronous jobs. `job_key` is the primary
 * key because it is deterministic across replays of the same work: a crash
 * between submitting and recording must find the earlier row rather than buy
 * the same paid job twice.
 */
import type postgres from 'postgres';

export async function applyMigration177(
  sqlClient: postgres.Sql,
  schemaName: string,
): Promise<void> {
  await sqlClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "${schemaName}".async_jobs (
        job_key            text PRIMARY KEY,
        run_id             text NOT NULL,
        step_execution_id  text NOT NULL,
        attempt            integer NOT NULL DEFAULT 0,
        operation_id       text NOT NULL,
        provider           text NOT NULL,
        model              text,
        state              text NOT NULL,
        replay_guarantee   jsonb NOT NULL,
        client_request_id  text NOT NULL,
        input_hash         text NOT NULL,
        provider_job_id    text,
        poll_count         integer NOT NULL DEFAULT 0,
        last_error         text,
        cost_currency      text,
        cost_micros        bigint,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_async_jobs_step
        ON "${schemaName}".async_jobs (run_id, step_execution_id, attempt);

      CREATE INDEX IF NOT EXISTS idx_async_jobs_live
        ON "${schemaName}".async_jobs (state)
        WHERE state IN ('submitting','submitted','polling');

      INSERT INTO "${schemaName}".schema_migrations (version, description)
      VALUES (177, 'Async-job lifecycle table for provider-side asynchronous jobs')
      ON CONFLICT (version) DO NOTHING;
    `);
}
