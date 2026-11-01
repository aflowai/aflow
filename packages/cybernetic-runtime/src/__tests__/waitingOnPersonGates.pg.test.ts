/**
 * The run gates and consents the Helmsman's attention block counts (Plan 338
 * D2), against a real database. Each kind is counted as its Action Center
 * source lists it. A request held inline is read by its own kind, so a
 * conversation waiting for its next message is no gate. An executor's
 * request, held outside its ref, is read by the paused step's operation and
 * the pause type. A consent a workflow run owns is the run's alone. A paused
 * workflow task is a human task where its hydration is stamped for the pause
 * or its definition resolves to a human task, and a write approval where it
 * holds the run's pause and asks for one. The suite runs only where
 * DATABASE_URL names a Postgres database whose tenant schema holds the tables
 * it reads, and it skips otherwise.
 *
 * The sources live in `@aflow/server-runtime`, which depends on this package,
 * so this suite cannot call their `listOpen`. Each fixture pins one source
 * rule by hand, and each number asserted is what that rule lists for the
 * fixtures. A later change to a source fails no test here, so change the
 * count, its fixture and this list together. The rules pinned:
 *
 * - `pausedStepSource`: a PAUSED session with a ref and a current step, of the
 *   newest 1,000 by start, listed by the request kind its ref holds. Input,
 *   approval and write approval list as gates. An OAuth consent lists unless
 *   the session's own hot state names a `workflowExecution`.
 * - `pausedStepSource`, bubbled: a parent paused `subflow_waiting` holds its
 *   child's ref, so it lists by the child's request, at every level.
 * - `pausedStepSource`, unreadable: a ref that does not decode to a JSON
 *   object with a known `kind` lists nothing.
 * - `workflowOAuthConsentSource`: of the newest 200 runs paused
 *   `needs_oauth_consent`, each whose resume contract carries `oauthConsent`.
 * - `workflowHumanTaskSource`: of the newest 200 paused tasks of paused runs,
 *   each stamped for its pause or defined as a human task.
 * - `workflowWriteApprovalSource`: of the newest 200 tasks holding their
 *   run's `task_paused` payload, each whose request is a write approval.
 * - `computeEgressSource`: pending egress requests, tenant-wide or this
 *   space's.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  createDatabase,
  createTenantContext,
  egressApprovalRequests,
  sessions,
  spaces,
  tenantIdToSchemaName,
  withTenantSchema,
  workflowRuns,
  workflowRunTasks,
} from '@aflow/database';
import { ACTION_CENTER_ITEM_ID_PREFIX, type TenantId } from '@aflow/schemas';
import { readWaitingGates, renderWaitingOnPerson } from '../waitingOnPerson.js';

/** The definitions a run's pinned revision resolves to, by workflow slug. */
const { definitions } = vi.hoisted(() => ({
  definitions: new Map<string, { slug: string; tasks: Array<Record<string, unknown>> }>(),
}));

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    // A slug with no definition here throws, as a revision with no pinned snapshot does.
    resolveWorkflowForRunRevision: (
      _db: unknown,
      _tenant: unknown,
      _space: unknown,
      slug: string,
    ) => {
      const workflow = definitions.get(slug);
      return workflow !== undefined
        ? Promise.resolve({ workflow, source: 'revision' as const })
        : Promise.reject(new Error(`No pinned revision for ${slug}`));
    },
  };
});

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const TENANT_SCHEMA = tenantIdToSchemaName(TENANT_ID);
const SPACE_ID = randomUUID();
const SLUG = `waiting-${SPACE_ID.slice(0, 8)}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

function inline(payload: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64')}`;
}

/** A ref as the payload store writes an executor's request: held outside the ref. */
function storedRef(name: string): string {
  return `tenants/${TENANT_ID}/runs/${randomUUID()}/steps/${randomUUID()}/attempt/1/${name}.json`;
}

/** The snapshot a paused session is flushed with: the run's hot state and the paused step's. */
function pausedSnapshot(
  stepExecutionId: string,
  operationId: string,
  runHotState: Record<string, unknown> = {},
): unknown {
  return {
    runHotState: { status: 'PAUSED', ...runHotState },
    stepHotStates: { [stepExecutionId]: { stepExecutionId, operationId, status: 'PAUSED' } },
  };
}

describeDb('readWaitingGates — counts over the tables the sources read (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const tenant = createTenantContext(TENANT_ID);
  const spaceIds: string[] = [];
  const sessionIds: string[] = [];
  const runIds: string[] = [];
  const egressIds: string[] = [];
  let clock = Date.parse('2026-11-01T00:00:00.000Z');

  /** A later instant on every call, so the newest item is the one just written. */
  function tick(): Date {
    clock += 60_000;
    return new Date(clock);
  }

  let tablesPresent = false;

  beforeAll(async () => {
    const rows = await handle.sql<{ present: number }[]>`
      SELECT count(*)::int AS present FROM information_schema.tables
      WHERE (table_schema = ${TENANT_SCHEMA}
              AND table_name IN ('spaces', 'sessions', 'workflow_runs', 'workflow_run_tasks'))
         OR (table_schema = 'public' AND table_name = 'egress_approval_requests')`;
    tablesPresent = rows[0]?.present === 5;
  });

  beforeEach((test) => {
    if (!tablesPresent) test.skip();
  });

  afterAll(async () => {
    if (!tablesPresent) {
      await handle.close();
      return;
    }
    await withTenantSchema(handle.db, tenant, async (tx) => {
      if (sessionIds.length > 0)
        await tx.delete(sessions).where(inArray(sessions.sessionId, sessionIds));
      if (runIds.length > 0)
        await tx.delete(workflowRunTasks).where(inArray(workflowRunTasks.runId, runIds));
      if (spaceIds.length > 0) {
        await tx.delete(workflowRuns).where(inArray(workflowRuns.spaceId, spaceIds));
        await tx.delete(spaces).where(inArray(spaces.id, spaceIds));
      }
    });
    if (egressIds.length > 0)
      await handle.db
        .delete(egressApprovalRequests)
        .where(inArray(egressApprovalRequests.requestId, egressIds));
    await handle.close();
  });

  async function space(id: string = randomUUID()): Promise<string> {
    spaceIds.push(id);
    await withTenantSchema(handle.db, tenant, (tx) =>
      tx
        .insert(spaces)
        .values({ id, name: 'Waiting', slug: id === SPACE_ID ? SLUG : `waiting-${id}` }),
    );
    return id;
  }

  async function pausedSession(
    ref: string,
    snapshot?: (stepExecutionId: string) => unknown,
    spaceId: string = SPACE_ID,
  ): Promise<{ sessionId: string; itemId: string }> {
    const sessionId = randomUUID();
    const stepExecutionId = randomUUID();
    sessionIds.push(sessionId);
    await withTenantSchema(handle.db, tenant, (tx) =>
      tx.insert(sessions).values({
        sessionId,
        targetKind: 'platform-role',
        agentVersion: '1',
        status: 'PAUSED',
        spaceId,
        startedAt: tick(),
        currentStepExecutionId: stepExecutionId,
        requestedInputRef: ref,
        ...(snapshot !== undefined ? { hotStateSnapshot: snapshot(stepExecutionId) } : {}),
      }),
    );
    return { sessionId, itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.pausedStep}${stepExecutionId}` };
  }

  /** A paused run with one paused task, as the harness leaves a task's pause. */
  async function pausedTask(
    spaceId: string,
    params: {
      workflowSlug: string;
      taskId: string;
      pausedReason?: string;
      /** The run's pause payload; the task holds it too unless `taskOutputRef` says otherwise. */
      pausedPayloadRef?: string;
      taskOutputRef?: string | null;
      pauseVersion?: number;
      hydration?: { pauseVersion: number; attempt: number };
    },
  ): Promise<string> {
    const runId = randomUUID();
    runIds.push(runId);
    const pauseVersion = params.pauseVersion ?? 1;
    const at = tick();
    await withTenantSchema(handle.db, tenant, async (tx) => {
      await tx.insert(workflowRuns).values({
        spaceId,
        workflowSlug: params.workflowSlug,
        runId,
        status: 'paused',
        workflowRevision: 1,
        startedAt: at,
        pausedReason: params.pausedReason ?? 'task_paused',
        pauseVersion,
        ...(params.pausedPayloadRef !== undefined
          ? { pausedPayloadRef: params.pausedPayloadRef }
          : {}),
      });
      const outputRef =
        params.taskOutputRef !== undefined ? params.taskOutputRef : params.pausedPayloadRef;
      await tx.insert(workflowRunTasks).values({
        runId,
        taskId: params.taskId,
        status: 'paused',
        attempt: 1,
        startedAt: at,
        completedAt: at,
        ...(outputRef != null ? { outputRef } : {}),
        ...(params.hydration !== undefined
          ? {
              humanTaskHydrationRef: storedRef('human_task_hydration'),
              humanTaskHydrationPauseVersion: params.hydration.pauseVersion,
              humanTaskHydrationAttempt: params.hydration.attempt,
            }
          : {}),
      });
    });
    return runId;
  }

  async function read(spaceId: string) {
    const { gates } = await readWaitingGates({ db: handle.db, tenantId: TENANT_ID, spaceId });
    return gates;
  }

  it('counts gates and consents by the request each pause holds, and drops one on approval', async () => {
    await space(SPACE_ID);

    const { sessionId: approval } = await pausedSession(
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
      () => ({ runHotState: { workflowExecution: { runId: 'r' } }, stepHotStates: {} }),
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

  it('counts no request whose kind it cannot read, and survives one Postgres cannot parse', async () => {
    const before = await read(SPACE_ID);
    // Held outside the ref, with no paused step and no pause type to say what it asks.
    await pausedSession(storedRef('requested_input'));
    // The read survives a payload jsonb refuses, and counts it as no item.
    await pausedSession(inline({ kind: 'approval', title: 'nul \u0000 inside' }));
    // Text that is not base64, bytes that are not UTF-8 and text that is not
    // JSON each cost their own row, not the read.
    await pausedSession('inline:not base64!');
    await pausedSession(`inline:${Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString('base64')}`);
    await pausedSession(`inline:${Buffer.from('{"kind": "approval"', 'utf-8').toString('base64')}`);
    // A bubbled pause whose child id is no UUID is followed nowhere.
    await pausedSession(storedRef('requested_input'), (step) =>
      pausedSnapshot(step, 'agent.control.delegate', {
        pauseType: 'subflow_waiting',
        pausedChildSessionId: 'not-a-uuid',
      }),
    );
    // One readable request among them is still counted.
    await pausedSession(inline({ kind: 'input', prompt: 'Which region?' }));
    const after = await read(SPACE_ID);
    expect(after.runGates).toBe(before.runGates + 1);
    expect(after.consents).toBe(before.consents);
  });

  it("counts a child's pause bubbled to each parent, as the step source lists every level", async () => {
    const spaceId = await space();
    const ref = storedRef('requested_input');
    const runner = await pausedSession(
      ref,
      (step) =>
        pausedSnapshot(step, 'user.interaction.ask', {
          workflowExecution: { runId: 'r', taskId: 't', attempt: 1 },
        }),
      spaceId,
    );
    const bubbled = (child: string) => (step: string) =>
      pausedSnapshot(step, 'agent.control.delegate', {
        pauseType: 'subflow_waiting',
        delegationPauseSource: 'child_input',
        pausedChildSessionId: child,
      });
    const driver = await pausedSession(ref, bubbled(runner.sessionId), spaceId);
    const helmsman = await pausedSession(ref, bubbled(driver.sessionId), spaceId);

    let gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 0 });
    expect(gates.newest.map((item) => item.itemId)).toEqual([
      helmsman.itemId,
      driver.itemId,
      runner.itemId,
    ]);
    expect(gates.newest[0]).toMatchObject({ kind: 'run_gate', title: 'Information requested' });

    // A parent whose child holds another ref no longer waits on that child's request.
    await pausedSession(storedRef('requested_input'), bubbled(runner.sessionId), spaceId);
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 0 });

    // A consent bubbled from a run's Runner is listed by each parent, whose own
    // hot state names no workflow run.
    const consentRef = storedRef('requested_input');
    const routed = await pausedSession(
      consentRef,
      (step) =>
        pausedSnapshot(step, 'mcp.tool.call', {
          pauseType: 'oauth_consent',
          workflowExecution: { runId: 'r', taskId: 't', attempt: 1 },
        }),
      spaceId,
    );
    await pausedSession(consentRef, bubbled(routed.sessionId), spaceId);
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 1 });
  });

  it('counts consent runs only among the newest the consent source lists', async () => {
    const spaceId = await space();
    const consentRunId = await pausedTask(spaceId, {
      workflowSlug: 'sync-crm',
      taskId: 'sync',
      pausedReason: 'needs_oauth_consent',
      pausedPayloadRef: inline({ oauthConsent: { resourceKey: 'hubspot', bindingId: 'b-4' } }),
      taskOutputRef: null,
    });
    expect(await read(spaceId)).toMatchObject({ consents: 1 });

    // 200 newer runs paused for a consent their contract does not carry fill
    // the source's window, and it drops each of them.
    const newer = Array.from({ length: 200 }, () => {
      const runId = randomUUID();
      runIds.push(runId);
      return {
        spaceId,
        workflowSlug: 'sync-crm',
        runId,
        status: 'paused' as const,
        workflowRevision: 1,
        startedAt: tick(),
        pausedReason: 'needs_oauth_consent',
        pausedPayloadRef: inline({ pauseCause: 'needs_oauth_consent' }),
      };
    });
    await withTenantSchema(handle.db, tenant, (tx) => tx.insert(workflowRuns).values(newer));
    const gates = await read(spaceId);
    expect(gates.consents).toBe(0);
    expect(gates.newest.map((item) => item.itemId)).not.toContain(
      `${ACTION_CENTER_ITEM_ID_PREFIX.workflowOAuthConsent}${consentRunId}`,
    );
  });

  it("reads each executor pause's kind from the paused step and the pause type", async () => {
    const spaceId = await space();
    const ref = () => storedRef('requested_input');

    // user.interaction.ask: the step source lists a request for input.
    const input = await pausedSession(
      ref(),
      (step) => pausedSnapshot(step, 'user.interaction.ask'),
      spaceId,
    );
    let gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 1, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: input.itemId,
      kind: 'run_gate',
      title: 'Information requested',
    });

    // user.interaction.approve, with a consent's pause type left from an earlier pause.
    const approval = await pausedSession(
      ref(),
      (step) => pausedSnapshot(step, 'user.interaction.approve', { pauseType: 'oauth_consent' }),
      spaceId,
    );
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 2, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: approval.itemId,
      kind: 'run_gate',
      title: 'Approval requested',
    });

    // A write approval: the orchestrator stamps the pause type `approval`.
    const write = await pausedSession(
      ref(),
      (step) => pausedSnapshot(step, 'api.endpoint.call', { pauseType: 'approval' }),
      spaceId,
    );
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 0 });
    expect(gates.newest[0]).toMatchObject({ itemId: write.itemId, kind: 'run_gate' });

    // An OAuth consent the session itself waits on is a consent, not a run gate.
    const consent = await pausedSession(
      ref(),
      (step) => pausedSnapshot(step, 'mcp.tool.call', { pauseType: 'oauth_consent' }),
      spaceId,
    );
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 1 });
    expect(gates.newest[0]).toMatchObject({
      itemId: consent.itemId,
      kind: 'consent',
      title: 'Connect this integration',
    });

    // A harness-routed consent is listed once, by the run that owns it.
    const routed = await pausedSession(
      ref(),
      (step) =>
        pausedSnapshot(step, 'mcp.tool.call', {
          pauseType: 'oauth_consent',
          workflowExecution: { runId: 'r', taskId: 't', attempt: 1 },
        }),
      spaceId,
    );
    const consentRun = await pausedTask(spaceId, {
      workflowSlug: 'no-definition',
      taskId: 'sync',
      pausedReason: 'needs_oauth_consent',
      pausedPayloadRef: inline({ oauthConsent: { resourceKey: 'hubspot', bindingId: 'b-9' } }),
      taskOutputRef: null,
    });
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 2 });
    const ids = gates.newest.map((item) => item.itemId);
    expect(ids).not.toContain(routed.itemId);
    expect(gates.newest[0]).toMatchObject({
      itemId: `${ACTION_CENTER_ITEM_ID_PREFIX.workflowOAuthConsent}${consentRun}`,
      kind: 'consent',
      title: 'Connect hubspot',
    });

    // Any other executor pause asks nothing the step source lists.
    const mock = await pausedSession(
      ref(),
      (step) => pausedSnapshot(step, 'mock.echo.run'),
      spaceId,
    );
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 2 });
    expect(gates.newest.map((item) => item.itemId)).not.toContain(mock.itemId);
  });

  it('counts paused workflow tasks as the human-task and write-approval sources list them', async () => {
    const spaceId = await space();
    definitions.set('review-flow', {
      slug: 'review-flow',
      tasks: [
        { taskId: 'review', name: 'Review the draft', type: 'human', pauseInstruction: 'Read it.' },
        { taskId: 'post', name: 'Post to the CRM', type: 'operation', operation: 'api.crm.update' },
        {
          taskId: 'ask',
          name: 'Ask the owner',
          type: 'operation',
          operation: 'user.interaction.ask',
        },
        { taskId: 'draft', name: 'Draft the reply', type: 'agent', agent: 'writer' },
      ],
    });
    const humanTaskId = (runId: string, taskId: string) =>
      `${ACTION_CENTER_ITEM_ID_PREFIX.workflowHumanTask}${runId}:${taskId}`;
    const writeApprovalId = (runId: string, pauseVersion: number) =>
      `${ACTION_CENTER_ITEM_ID_PREFIX.workflowWriteApproval}${runId}:${String(pauseVersion)}`;

    // A human task with no hydration stamp, whose definition still resolves to
    // one. It holds the run's pause too, and is counted once, as a human task.
    const unstamped = await pausedTask(spaceId, {
      workflowSlug: 'review-flow',
      taskId: 'review',
      pausedPayloadRef: storedRef('resume_contract'),
    });
    let gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 1, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: humanTaskId(unstamped, 'review'),
      kind: 'run_gate',
      title: 'Review the draft',
    });

    // A human task stamped for the pause it stands at, whose definition is gone.
    const stamped = await pausedTask(spaceId, {
      workflowSlug: 'retired-flow',
      taskId: 'sign-off',
      pauseVersion: 3,
      hydration: { pauseVersion: 3, attempt: 1 },
    });
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 2, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: humanTaskId(stamped, 'sign-off'),
      title: 'sign-off',
    });

    // A stamp from an earlier pause, with no definition to fall back on, is listed by neither.
    const stale = await pausedTask(spaceId, {
      workflowSlug: 'retired-flow',
      taskId: 'sign-off',
      pauseVersion: 4,
      hydration: { pauseVersion: 2, attempt: 1 },
    });
    gates = await read(spaceId);
    expect(gates.runGates).toBe(2);
    expect(gates.newest.map((item) => item.itemId)).not.toContain(humanTaskId(stale, 'sign-off'));

    // An operation task's write approval, held outside the ref.
    const stored = await pausedTask(spaceId, {
      workflowSlug: 'review-flow',
      taskId: 'post',
      pausedPayloadRef: storedRef('requested_input'),
    });
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 3, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: writeApprovalId(stored, 1),
      kind: 'run_gate',
      title: 'Approval requested',
    });

    // A write approval held inline is read by its own kind and titled by it.
    const held = await pausedTask(spaceId, {
      workflowSlug: 'retired-flow',
      taskId: 'post',
      pauseVersion: 2,
      pausedPayloadRef: inline({
        kind: 'write_approval',
        target: 'api',
        apiId: 'crm',
        endpointId: 'deals.update',
        operationLabel: 'Update the deal',
        method: 'PATCH',
        urlHost: 'crm.example.com',
        writeRiskTier: 'medium',
        requestHash: 'h-1',
      }),
    });
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 4, consents: 0 });
    expect(gates.newest[0]).toMatchObject({
      itemId: writeApprovalId(held, 2),
      title: 'Approve write: Update the deal',
    });

    // Neither source lists the user executor's request on an operation task, an
    // agent task's pause, an inline request of another kind, or a task that no
    // longer holds the run's pause.
    await pausedTask(spaceId, {
      workflowSlug: 'review-flow',
      taskId: 'ask',
      pausedPayloadRef: storedRef('requested_input'),
    });
    await pausedTask(spaceId, {
      workflowSlug: 'review-flow',
      taskId: 'draft',
      pausedPayloadRef: storedRef('resume_contract'),
    });
    await pausedTask(spaceId, {
      workflowSlug: 'retired-flow',
      taskId: 'post',
      pausedPayloadRef: inline({ kind: 'input', prompt: 'Which deal?' }),
    });
    await pausedTask(spaceId, {
      workflowSlug: 'review-flow',
      taskId: 'post',
      pausedPayloadRef: storedRef('requested_input'),
      taskOutputRef: storedRef('output'),
    });
    gates = await read(spaceId);
    expect(gates).toMatchObject({ runGates: 4, consents: 0 });
  });
});
