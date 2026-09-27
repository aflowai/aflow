/**
 * The async-job lifecycle against a real database.
 *
 * The unit tests render the statements; only Postgres can show that two callers
 * racing the same work end up with one paid job. Gated on DATABASE_URL like
 * every pg test.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { deriveAsyncJobKey, resolveAsyncJobRecovery, type AsyncJobIdentity } from '@aflow/schemas';
import { createDatabase } from '../../connection.js';
import { createTenantContext } from '../../tenant/context.js';
import { withTenantSchema } from '../../tenant/queries.js';
import type { TenantContext } from '../../tenant/context.js';
import { createAsyncJobRepository, AsyncJobIdentityMismatchError } from '../asyncJobs.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('async_jobs — one paid job per unit of work (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);
  const repo = createAsyncJobRepository(db, tenantCtx);

  const RUN = randomUUID();
  let schemaReady = false;
  let tenantPresent = false;

  const identityFor = (overrides: Partial<AsyncJobIdentity> = {}): AsyncJobIdentity => ({
    runId: RUN,
    logicalExecutionId: 'shot-1',
    attempt: 0,
    operationId: 'ai.media.video',
    provider: 'acme',
    inputHash: 'hash-1',
    ...overrides,
  });

  const DEDUPED = { kind: 'idempotency_key', field: 'X-Idempotency-Key' } as const;
  const NO_DEDUPE = { kind: 'unknown_terminal' } as const;

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'async_jobs'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    const present = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
      ) AS ok`;
    tenantPresent = present[0]?.ok === true;
  });

  // A tenant that was never created is CI, which seeds no dev schema and where a
  // database-backed suite has nothing to say. A tenant that exists without the
  // column is a checkout that has not migrated, which is worth failing on.
  beforeEach((ctx) => {
    if (!tenantPresent) {
      ctx.skip();
      return;
    }
    if (!schemaReady) throw new Error('async_jobs is missing — run yarn db:migrate');
  });

  afterAll(async () => {
    if (schemaReady) {
      await withTenantSchema(db, tenantCtx, (tx) =>
        tx.execute(drizzleSql`DELETE FROM async_jobs WHERE run_id = ${RUN}`),
      );
    }
    await handle.close();
  });

  it('has the table (migration 177 applied)', () => {
    expect(schemaReady).toBe(true);
  });

  // The reservation is the idempotency anchor: whatever the interleaving, the
  // same work must end up with exactly one row, so only one caller ever submits.
  it('two callers racing the same identity produce one job, and one of them knows it', async () => {
    const identity = identityFor({ logicalExecutionId: 'race-1' });
    const [a, b] = await Promise.all([
      repo.reserveJob({ identity, replayGuarantee: DEDUPED }),
      repo.reserveJob({ identity, replayGuarantee: DEDUPED }),
    ]);

    expect(a.record.jobKey).toBe(b.record.jobKey);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const rows = await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute<{ count: number }>(
        drizzleSql`SELECT count(*)::int AS count FROM async_jobs WHERE job_key = ${a.record.jobKey}`,
      ),
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('a different attempt is different work and buys its own job', async () => {
    const first = identityFor({ logicalExecutionId: 'attempts', attempt: 0 });
    const second = identityFor({ logicalExecutionId: 'attempts', attempt: 1 });

    const a = await repo.reserveJob({ identity: first, replayGuarantee: DEDUPED });
    const b = await repo.reserveJob({ identity: second, replayGuarantee: DEDUPED });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.record.jobKey).not.toBe(b.record.jobKey);
  });

  it('refuses a conflicting key whose row is not the same work', async () => {
    const identity = identityFor({ logicalExecutionId: 'mismatch' });
    await repo.reserveJob({ identity, replayGuarantee: DEDUPED });

    // Same derived key, different stored identity: only reachable by corrupting
    // the row, which is exactly the case the conflict check exists to catch.
    await withTenantSchema(db, tenantCtx, (tx) =>
      tx.execute(
        drizzleSql`UPDATE async_jobs SET input_hash = 'tampered' WHERE job_key = ${deriveAsyncJobKey(identity)}`,
      ),
    );

    await expect(repo.reserveJob({ identity, replayGuarantee: DEDUPED })).rejects.toBeInstanceOf(
      AsyncJobIdentityMismatchError,
    );
  });

  // Only one worker may drive a transition, or two of them call the provider.
  it('two workers racing the same transition: exactly one wins', async () => {
    const identity = identityFor({ logicalExecutionId: 'cas-race' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: DEDUPED });

    const results = await Promise.all([
      repo.markSubmitting(record.jobKey, 'reserved'),
      repo.markSubmitting(record.jobKey, 'reserved'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('a settled job cannot be re-settled', async () => {
    const identity = identityFor({ logicalExecutionId: 'settled' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: DEDUPED });
    await repo.markSubmitting(record.jobKey, 'reserved');
    await repo.markSubmitted(record.jobKey, 'provider-1');

    expect(await repo.markTerminal(record.jobKey, 'succeeded')).toBe(true);
    expect(await repo.markTerminal(record.jobKey, 'failed')).toBe(false);
    expect((await repo.getJob(record.jobKey))?.state).toBe('succeeded');
  });

  // The crash window, both guarantee families. A worker that dies after
  // `submitting` is written leaves a row that recovery must read correctly.
  it('recovers a deduped route by re-submitting through the provider key', async () => {
    const identity = identityFor({ logicalExecutionId: 'crash-deduped' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: DEDUPED });
    await repo.markSubmitting(record.jobKey, 'reserved');

    const observed = await repo.getJob(record.jobKey);
    expect(observed?.state).toBe('submitting');
    expect(resolveAsyncJobRecovery(observed!.state, observed!.replayGuarantee)).toBe(
      'resubmit_deduped',
    );
    // The re-entry is allowed because the stored guarantee permits it.
    expect(await repo.markSubmitting(record.jobKey, 'submitting')).toBe(true);
  });

  it('strands an undeduped route in submitting rather than paying twice', async () => {
    const identity = identityFor({ logicalExecutionId: 'crash-undeduped' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: NO_DEDUPE });
    await repo.markSubmitting(record.jobKey, 'reserved');

    const observed = await repo.getJob(record.jobKey);
    expect(resolveAsyncJobRecovery(observed!.state, observed!.replayGuarantee)).toBe(
      'mark_unknown',
    );
    // The guard is in the WHERE clause, not in caller discipline: even a caller
    // that ignores the recovery helper cannot re-enter submitting here.
    expect(await repo.markSubmitting(record.jobKey, 'submitting')).toBe(false);
  });

  it('reconciles an unknown job without automation ever resubmitting it', async () => {
    const identity = identityFor({ logicalExecutionId: 'reconcile' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: NO_DEDUPE });
    await repo.markSubmitting(record.jobKey, 'reserved');
    await repo.markTerminal(record.jobKey, 'unknown', { lastError: 'ambiguous submit' });

    expect(
      await repo.reconcileUnknownJob(record.jobKey, 'succeeded', {
        reconciledBy: 'operator:test',
        providerJobId: 'provider-found',
        actualCost: { currency: 'USD', micros: 4_200_000 },
      }),
    ).toBe(true);

    const settled = await repo.getJob(record.jobKey);
    expect(settled?.state).toBe('succeeded');
    expect(settled?.providerJobId).toBe('provider-found');
    expect(settled?.actualCost).toEqual({ currency: 'USD', micros: 4_200_000 });

    // Reconciliation is not a second settle path.
    expect(
      await repo.reconcileUnknownJob(record.jobKey, 'failed', { reconciledBy: 'operator:test' }),
    ).toBe(false);
  });

  it('survives an error body longer than the record allows', async () => {
    const identity = identityFor({ logicalExecutionId: 'huge-error' });
    const { record } = await repo.reserveJob({ identity, replayGuarantee: DEDUPED });
    await repo.markTerminal(record.jobKey, 'failed', { lastError: 'x'.repeat(9_000) });

    // Unclamped this row would commit and then throw on every later read,
    // including the conflict path that makes reserveJob the idempotency anchor.
    const readBack = await repo.getJob(record.jobKey);
    expect(readBack?.state).toBe('failed');
    expect(readBack?.lastError?.length).toBeLessThanOrEqual(2_000);
    await expect(repo.reserveJob({ identity, replayGuarantee: DEDUPED })).resolves.toMatchObject({
      created: false,
    });
  });
});
