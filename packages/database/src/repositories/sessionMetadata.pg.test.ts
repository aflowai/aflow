/**
 * The conversation-metadata store against a real database.
 *
 * Every property here is a property of what Postgres ends up holding — a
 * rename that loses a race, an evidence read that has to find what was said
 * across four different event shapes — so a fake repository could not tell any
 * of them apart from their absence.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import {
  applyGeneratedSessionMetadata,
  readSessionEvidence,
  readSessionMetadata,
  recordSessionMetadataDiagnostic,
  setManualSessionTitle,
} from './sessionMetadata.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
/**
 * This suite's namespace, and inside it one space of this execution's own. The
 * namespace is what a later run sweeps an aborted one by; the random tail
 * keeps two concurrent runs — two worktrees, a re-run started before the last
 * finished — out of each other's rows.
 */
const SPACE_NAMESPACE = 'd0000000-0000-0000-304b-';
const SPACE_ID = `${SPACE_NAMESPACE}${randomBytes(6).toString('hex')}`;
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('session metadata store (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID);

  let ready = false;

  async function insertSession(sessionId: string, startedAt: Date): Promise<void> {
    const at = startedAt.toISOString();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO sessions (session_id, target_kind, target_system_role, agent_version,
                              status, started_at, last_activity_at, space_id)
        VALUES (${sessionId}::uuid, 'platform-role', 'cybernetic-helmsman', '1',
                'PAUSED', ${at}::timestamptz, ${at}::timestamptz, ${SPACE_ID}::uuid)
      `);
    });
  }

  async function insertEvent(
    sessionId: string,
    eventType: string,
    metadata: Record<string, unknown>,
    at: Date,
  ): Promise<void> {
    const envelope = JSON.stringify({ metadata });
    const ts = at.toISOString();
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO event_log (event_id, event_type, session_id, timestamp, idempotency_key, envelope)
        VALUES (${randomUUID()}::uuid, ${eventType}, ${sessionId}::uuid, ${ts}::timestamptz,
                ${randomUUID()}, ${envelope}::jsonb)
      `);
    });
  }

  beforeAll(async () => {
    const rows = await sql`
      SELECT 1 FROM information_schema.schemata WHERE schema_name = ${TENANT_SCHEMA}
    `;
    ready = rows.length > 0;
    if (!ready) return;
    // What earlier executions of this suite left behind. Only rows old enough
    // that no live execution could still be writing them.
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.execute(drizzleSql`
        DELETE FROM event_log WHERE session_id IN (
          SELECT session_id FROM sessions
           WHERE space_id::text LIKE ${`${SPACE_NAMESPACE}%`}
             AND started_at < now() - interval '1 hour')
      `);
      await tx.execute(drizzleSql`
        DELETE FROM sessions WHERE space_id::text LIKE ${`${SPACE_NAMESPACE}%`}
          AND started_at < now() - interval '1 hour'
      `);
    });
  });

  afterAll(async () => {
    if (ready) {
      await withTenantSchema(db, tenantCtx, async (tx) => {
        await tx.execute(drizzleSql`
          DELETE FROM event_log WHERE session_id IN (
            SELECT session_id FROM sessions WHERE space_id = ${SPACE_ID}::uuid)
        `);
        await tx.execute(drizzleSql`DELETE FROM sessions WHERE space_id = ${SPACE_ID}::uuid`);
      });
    }
    await handle.close();
  });

  it('applies a generated title without disturbing an untouched summary', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    await insertSession(sessionId, new Date());

    await applyGeneratedSessionMetadata(db, TENANT_ID, sessionId, {
      title: 'Missing invoices',
      titleState: 'provisional',
      summary: 'Three invoices are missing from the export.',
      summaryCoverage: 'full',
      evidenceRevision: 2,
    });
    // A later title-only refinement must not blank the summary someone is
    // reading — each field is written only when supplied.
    await applyGeneratedSessionMetadata(db, TENANT_ID, sessionId, {
      title: 'Missing Q3 invoices',
      titleState: 'established',
      evidenceRevision: 3,
    });

    const stored = await readSessionMetadata(db, TENANT_ID, sessionId);
    expect(stored).toMatchObject({
      title: 'Missing Q3 invoices',
      titleState: 'established',
      summary: 'Three invoices are missing from the export.',
      metadataEvidenceRevision: 3,
    });
    // A background write is not a rename: the conflict handle two people
    // collide on stays exactly where the last person left it.
    expect(stored?.metadataRevision).toBe(0);
  });

  it('lets a rename and a generation land without contending', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    await insertSession(sessionId, new Date());
    const editor = randomUUID();

    await setManualSessionTitle(db, TENANT_ID, sessionId, {
      title: 'Q3 billing',
      editedByUserId: editor,
    });
    // The generation was already in flight when the rename landed. It writes
    // the column nobody reads rather than racing the one they do.
    await applyGeneratedSessionMetadata(db, TENANT_ID, sessionId, {
      title: 'Missing invoices',
      titleState: 'established',
      evidenceRevision: 1,
    });

    const stored = await readSessionMetadata(db, TENANT_ID, sessionId);
    expect(stored?.manualTitle).toBe('Q3 billing');
    expect(stored?.title).toBe('Missing invoices');
    expect(stored?.metadataEditedBy).toBe(editor);
  });

  it('tells the loser of a rename race rather than overwriting them', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    await insertSession(sessionId, new Date());
    const before = (await readSessionMetadata(db, TENANT_ID, sessionId))!.metadataRevision;

    const first = await setManualSessionTitle(db, TENANT_ID, sessionId, {
      title: 'Q3 billing',
      editedByUserId: randomUUID(),
      expectedRevision: before,
    });
    expect(first).toEqual({ ok: true, revision: before + 1 });

    const second = await setManualSessionTitle(db, TENANT_ID, sessionId, {
      title: 'Billing review',
      editedByUserId: randomUUID(),
      expectedRevision: before,
    });
    expect(second).toEqual({ ok: false, reason: 'conflict' });
    expect((await readSessionMetadata(db, TENANT_ID, sessionId))?.manualTitle).toBe('Q3 billing');
  });

  it('hands a conversation back to its automatic name', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    await insertSession(sessionId, new Date());
    await applyGeneratedSessionMetadata(db, TENANT_ID, sessionId, {
      title: 'Missing invoices',
      titleState: 'established',
      evidenceRevision: 1,
    });
    await setManualSessionTitle(db, TENANT_ID, sessionId, {
      title: 'Q3 billing',
      editedByUserId: randomUUID(),
    });

    await setManualSessionTitle(db, TENANT_ID, sessionId, {
      title: null,
      editedByUserId: randomUUID(),
    });
    const stored = await readSessionMetadata(db, TENANT_ID, sessionId);
    expect(stored?.manualTitle).toBeNull();
    expect(stored?.metadataEditedBy).toBeNull();
    expect(stored?.title).toBe('Missing invoices');
  });

  it('says a session is missing rather than reporting a conflict about it', async () => {
    if (!ready) return;
    const result = await setManualSessionTitle(db, TENANT_ID, randomUUID(), {
      title: 'Nothing',
      editedByUserId: randomUUID(),
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('records a diagnostic without touching the name or its revision', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    await insertSession(sessionId, new Date());
    await applyGeneratedSessionMetadata(db, TENANT_ID, sessionId, {
      title: 'Missing invoices',
      titleState: 'established',
      evidenceRevision: 1,
    });
    const before = (await readSessionMetadata(db, TENANT_ID, sessionId))!;

    await recordSessionMetadataDiagnostic(db, TENANT_ID, sessionId, {
      code: 'no_credential',
      message: 'No key resolves for fireworks.',
      at: new Date().toISOString(),
      retryable: true,
      attempts: 1,
    });

    const after = (await readSessionMetadata(db, TENANT_ID, sessionId))!;
    // A complaint is not a change to the name: bumping the revision would
    // invalidate a rename someone is midway through, for nothing they can see.
    expect(after.metadataRevision).toBe(before.metadataRevision);
    expect(after.title).toBe('Missing invoices');
    expect(after.record.diagnostic?.code).toBe('no_credential');
    expect(after.record.provenance).toBeUndefined();
  });

  it('reads what was said across every shape the log records it in', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    const t0 = new Date(Date.now() - 60_000);
    await insertSession(sessionId, t0);
    await insertEvent(
      sessionId,
      'SessionStarted',
      { userMessage: 'Find the missing invoices' },
      t0,
    );
    await insertEvent(
      sessionId,
      'StepSucceeded',
      { agentMessage: 'Three are missing from the Stripe export.' },
      new Date(t0.getTime() + 1_000),
    );
    await insertEvent(
      sessionId,
      'SessionResumed',
      { userMessage: 'And the March ones?' },
      new Date(t0.getTime() + 2_000),
    );
    await insertEvent(
      sessionId,
      'RoomMessage',
      {
        messageSeq: 3,
        actorUserId: randomUUID(),
        body: 'I checked those already',
        wakeHelmsman: false,
      },
      new Date(t0.getTime() + 3_000),
    );
    // Tool traffic is structurally absent: an event carrying neither a person's
    // words nor the agent's answer is not one of the shapes this reads.
    await insertEvent(
      sessionId,
      'StepSucceeded',
      { stepName: 'http_call', operationId: 'api.http.call' },
      new Date(t0.getTime() + 4_000),
    );
    // A delegated child's reply still arrives forwarded, on `agentMessage`.
    await insertEvent(
      sessionId,
      'StepSucceeded',
      { agentMessage: 'The March ones are drafts.' },
      new Date(t0.getTime() + 5_000),
    );

    const evidence = await readSessionEvidence(db, TENANT_ID, sessionId, 24);
    expect(evidence.openingRequest).toBe('Find the missing invoices');
    expect(evidence.exchanges.map((e) => [e.speaker, e.text])).toEqual([
      ['person', 'Find the missing invoices'],
      ['agent', 'Three are missing from the Stripe export.'],
      ['person', 'And the March ones?'],
      ['person', 'I checked those already'],
      ['agent', 'The March ones are drafts.'],
    ]);
    expect(evidence.complete).toBe(true);
  });

  it('keeps the recent end when the window binds, and marks the coverage partial', async () => {
    if (!ready) return;
    const sessionId = randomUUID();
    const t0 = new Date(Date.now() - 600_000);
    await insertSession(sessionId, t0);
    await insertEvent(sessionId, 'SessionStarted', { userMessage: 'turn 0' }, t0);
    for (let i = 1; i <= 8; i++) {
      await insertEvent(
        sessionId,
        'SessionResumed',
        { userMessage: `turn ${String(i)}` },
        new Date(t0.getTime() + i * 1_000),
      );
    }

    const evidence = await readSessionEvidence(db, TENANT_ID, sessionId, 4);
    expect(evidence.exchanges).toHaveLength(4);
    // The end someone is waiting on survives; the middle is what goes.
    expect(evidence.exchanges.at(-1)?.text).toBe('turn 8');
    expect(evidence.complete).toBe(false);
    // The opening request survives the window regardless — it is read
    // separately, because it is what the conversation is about.
    expect(evidence.openingRequest).toBe('turn 0');
  });
});
