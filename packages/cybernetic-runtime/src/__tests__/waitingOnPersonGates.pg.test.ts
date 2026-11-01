/**
 * The run gates and consents the Helmsman's attention block counts (Plan 338
 * D2), against a real database: Postgres reads each paused request's kind
 * from the payload its ref holds inline, so a conversation waiting for its
 * next message is no gate, a consent a workflow run owns is the run's, and an
 * approval drops the count by one. Gated on DATABASE_URL like every pg test.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  egressApprovalRequests,
  sessions,
  spaces,
  withTenantSchema,
  workflowRuns,
} from '@aflow/database';
import type { TenantId } from '@aflow/schemas';
import { readWaitingGates, renderWaitingOnPerson } from '../waitingOnPerson.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE_ID = randomUUID();
const SLUG = `waiting-${SPACE_ID.slice(0, 8)}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

function inline(payload: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
}

describeDb('readWaitingGates — counts over the tables the sources read (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const tenant = createTenantContext(TENANT_ID);
  const sessionIds: string[] = [];
  const egressIds: string[] = [];

  afterAll(async () => {
    await withTenantSchema(handle.db, tenant, async (tx) => {
      if (sessionIds.length > 0)
        await tx.delete(sessions).where(inArray(sessions.sessionId, sessionIds));
      await tx.delete(workflowRuns).where(eq(workflowRuns.spaceId, SPACE_ID));
      await tx.delete(spaces).where(eq(spaces.id, SPACE_ID));
    });
    if (egressIds.length > 0)
      await handle.db
        .delete(egressApprovalRequests)
        .where(inArray(egressApprovalRequests.requestId, egressIds));
    await handle.close();
  });

  async function pausedSession(ref: string, snapshot?: unknown): Promise<string> {
    const sessionId = randomUUID();
    sessionIds.push(sessionId);
    await withTenantSchema(handle.db, tenant, (tx) =>
      tx.insert(sessions).values({
        sessionId,
        targetKind: 'platform-role',
        agentVersion: '1',
        status: 'PAUSED',
        spaceId: SPACE_ID,
        currentStepExecutionId: randomUUID(),
        requestedInputRef: ref,
        ...(snapshot !== undefined ? { hotStateSnapshot: snapshot } : {}),
      }),
    );
    return sessionId;
  }

  it('counts gates and consents by the request each pause holds, and drops one on approval', async () => {
    await withTenantSchema(handle.db, tenant, (tx) =>
      tx.insert(spaces).values({ id: SPACE_ID, name: 'Waiting', slug: SLUG }),
    );

    const approval = await pausedSession(
      inline({
        kind: 'approval',
        title: 'Ship the release',
        description: 'BODY-SENTINEL: the release notes in full.',
        requestedAt: '2026-11-01T10:00:00.000Z',
      }),
    );
    await pausedSession(
      inline({
        kind: 'input',
        prompt: 'BODY-SENTINEL: which region?',
        requestedAt: '2026-11-01T09:00:00.000Z',
      }),
    );
    // A conversation waiting for its next message asks nothing of the Action Center.
    await pausedSession(inline({ reason: 'input_required', prompt: 'What next?' }));
    await pausedSession(
      inline({ kind: 'oauth_consent', resourceKey: 'github', bindingId: 'b-1', reason: 'expired' }),
    );
    // A consent a workflow run owns is shown by the run, not the step.
    await pausedSession(
      inline({ kind: 'oauth_consent', resourceKey: 'slack', bindingId: 'b-2', reason: 'expired' }),
      { runHotState: { workflowExecution: { runId: 'r' } }, stepHotStates: {} },
    );
    await withTenantSchema(handle.db, tenant, (tx) =>
      tx.insert(workflowRuns).values({
        spaceId: SPACE_ID,
        workflowSlug: 'sync-crm',
        runId: randomUUID(),
        status: 'paused',
        workflowRevision: 1,
        startedAt: new Date('2026-11-01T08:00:00.000Z'),
        pausedReason: 'needs_oauth_consent',
        pausedPayloadRef: inline({ oauthConsent: { resourceKey: 'hubspot', bindingId: 'b-3' } }),
      }),
    );
    const [egress] = await handle.db
      .insert(egressApprovalRequests)
      .values({
        tenantId: TENANT_ID,
        scope: 'space',
        spaceId: SPACE_ID,
        requestedHosts: ['pypi.org', 'files.pythonhosted.org'],
        requestedBy: 'agent',
      })
      .returning({ requestId: egressApprovalRequests.requestId });
    egressIds.push(egress!.requestId);

    const before = await readWaitingGates({
      db: handle.db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
    });
    expect(before.spaceSlug).toBe(SLUG);
    expect(before.gates.runGates).toBe(3);
    expect(before.gates.consents).toBe(2);
    const titles = before.gates.newest.map((item) => item.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Ship the release',
        'Information requested',
        'Connect github',
        'Connect hubspot',
        'Compute egress: 2 host(s)',
      ]),
    );
    const text = renderWaitingOnPerson({
      gates: before.gates,
      items: before.gates.newest,
      spaceSlug: SLUG,
    }).join('\n');
    expect(text).not.toContain('BODY-SENTINEL');
    expect(text).not.toContain('slack');

    await withTenantSchema(handle.db, tenant, (tx) =>
      tx
        .update(sessions)
        .set({ status: 'RUNNING', requestedInputRef: null })
        .where(eq(sessions.sessionId, approval)),
    );
    const after = await readWaitingGates({ db: handle.db, tenantId: TENANT_ID, spaceId: SPACE_ID });
    expect(after.gates.runGates).toBe(before.gates.runGates - 1);
    expect(after.gates.consents).toBe(before.gates.consents);
  });

  it('reads a payload held outside the ref as a gate, and one Postgres cannot parse as none', async () => {
    const before = await readWaitingGates({
      db: handle.db,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
    });
    await pausedSession('redis:payload:large-request');
    await pausedSession(inline({ kind: 'approval', title: 'nul \u0000 inside' }));
    // The read survives a payload jsonb refuses, and counts it as no item.
    const after = await readWaitingGates({ db: handle.db, tenantId: TENANT_ID, spaceId: SPACE_ID });
    expect(after.gates.runGates).toBe(before.gates.runGates + 1);
  });
});
