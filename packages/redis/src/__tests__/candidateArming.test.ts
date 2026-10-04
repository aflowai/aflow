/**
 * Every writer of session or step hot state must arm the candidate indexes the
 * watchdogs discover work through.
 *
 * A watchdog that reads only an index sees exactly what the writers put there,
 * and a writer that skips the arming makes its own transition invisible: the
 * step hangs SCHEDULED in Redis, the run hangs QUEUED, and nothing anywhere
 * reports a problem. A test suite that arms candidates through one convenient
 * helper cannot catch that, because the helper is never the writer that skips.
 *
 * So the coverage here is per-primitive rather than per-scenario: there are six
 * functions that can write these hashes, and each one gets its own case.
 *
 * Real Redis, on its own database: the claim is Lua over a sorted set with
 * server-clock leases, and a suite that claims from a global index cannot share
 * a database with another that does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { stackRedis } from '../../../../scripts/stackRedis.mjs';
import { StreamKeys, type SessionId, type StepExecutionId, type TenantId } from '@aflow/schemas';
import {
  setSessionState,
  updateSessionState,
  setStepState,
  updateStepState,
  atomicCreateSession,
  atomicCompleteStep,
  atomicScheduleStep,
  claimDueQueuedSessions,
  dropQueuedSessionCandidate,
  rearmQueuedSessionCandidate,
  peekDueStepStallCandidates,
  refreshStepStallCandidate,
  dropStepStallCandidate,
  stepStallEarliestReapAtMs,
  stepStallNextCheckAtMs,
  STEP_STALL_SCAN_INTERVAL_MS,
  STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS,
  STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
  peekDueDelegationSupervisionCandidates,
  refreshDelegationSupervisionCandidate,
  dropDelegationSupervisionCandidate,
  carryOverWaitingParents,
  DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
  type SessionHotState,
  type StepHotState,
  type SessionEvent,
} from '../hotState.js';
import { deleteSessionResidue } from '../sessionResidue.js';
import { markRunActive } from '../shard.js';

const TEST_DB = 13;

const STACK_REDIS = await stackRedis(TEST_DB);

const TENANT = 'tenant-candidate-arming' as TenantId;
const RUN = '00000000-0000-0000-0000-0000000000c1' as SessionId;
const STEP = '00000000-0000-0000-0000-0000000000d1' as StepExecutionId;
const MEMBER = `${TENANT}:${RUN}`;
const CREATED_AT = 1_700_000_000_000;

function makeRunState(overrides: Partial<SessionHotState> = {}): SessionHotState {
  return {
    sessionId: RUN,
    tenantId: TENANT,
    target: { kind: 'platform-role', systemRole: 'test-role' },
    agentVersion: '1',
    status: 'RUNNING',
    createdAt: CREATED_AT,
    lastUpdatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeStepState(overrides: Partial<StepHotState> = {}): StepHotState {
  return {
    stepExecutionId: STEP,
    tenantId: TENANT,
    sessionId: RUN,
    stepId: 'step-1',
    stepType: 'ai',
    operationId: 'ai.generate.text',
    attempt: 1,
    status: 'SCHEDULED',
    scheduledAt: CREATED_AT,
    inputRef: 'inline:test',
    idempotencyKey: 'key-1',
    ...overrides,
  };
}

function makeEvent(eventType: SessionEvent['eventType'] = 'StepScheduled'): SessionEvent {
  return { eventId: crypto.randomUUID(), eventType, timestamp: Date.now(), sessionId: RUN };
}

describe.skipIf(!STACK_REDIS.available)('candidate arming', () => {
  let redis: RedisType;

  async function reset(): Promise<void> {
    await redis.del(
      StreamKeys.stepStallCandidatesKey,
      StreamKeys.queuedSessionCandidatesKey,
      StreamKeys.projectionCandidatesKey,
      StreamKeys.projectionOrderKey,
      StreamKeys.projectionLeasesKey,
      StreamKeys.delegationSupervisionCandidatesKey,
      StreamKeys.activeRunsKey,
      StreamKeys.activeShardsKey,
      StreamKeys.sessionStateKey(TENANT, RUN),
      StreamKeys.stepStateKey(TENANT, STEP),
      StreamKeys.sessionEventsStream(TENANT, RUN),
    );
  }

  beforeEach(async () => {
    redis = new Redis(STACK_REDIS.url, { maxRetriesPerRequest: 1 });
    await reset();
  });

  afterEach(async () => {
    await reset();
    redis.disconnect();
  });

  async function stallScore(): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.stepStallCandidatesKey, MEMBER);
    return score === null ? null : Number(score);
  }

  async function queuedScore(): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.queuedSessionCandidatesKey, MEMBER);
    return score === null ? null : Number(score);
  }

  async function supervisionScore(): Promise<number | null> {
    const score = await redis.zscore(StreamKeys.delegationSupervisionCandidatesKey, MEMBER);
    return score === null ? null : Number(score);
  }

  describe('step-stall index', () => {
    it('arms on atomicCreateSession', async () => {
      await atomicCreateSession(
        redis,
        makeRunState({ status: 'RUNNING' }),
        makeStepState(),
        makeEvent('SessionStarted'),
        makeEvent(),
      );

      expect(await stallScore()).toBe(CREATED_AT + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS);
    });

    it('does not arm when the session is created already paused', async () => {
      // A run that pauses at creation has a PAUSED step; arming on "this
      // function was called" would leave it a candidate forever.
      await atomicCreateSession(
        redis,
        makeRunState({ status: 'PAUSED' }),
        makeStepState({ status: 'PAUSED' }),
        makeEvent('SessionStarted'),
        makeEvent(),
      );

      expect(await stallScore()).toBeNull();
    });

    it('arms on atomicScheduleStep', async () => {
      await atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState(),
        { status: 'RUNNING', currentStepExecutionId: STEP },
        makeEvent(),
      );

      expect(await stallScore()).toBe(CREATED_AT + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS);
    });

    it('does not clear when one step of a parallel batch completes', async () => {
      // The member is the session, but the status is one step's, and a session
      // can hold several at once. Clearing on any terminal step would let the
      // first sibling of a tool fan-out unarm the session while the others are
      // still running, and nothing would arm it again — a dead executor holding
      // one of them would then never be reaped.
      await atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState(),
        { status: 'RUNNING' },
        makeEvent(),
      );
      await atomicCompleteStep(
        redis,
        TENANT,
        { stepExecutionId: STEP, status: 'SUCCEEDED', endedAt: Date.now() },
        { sessionId: RUN, status: 'RUNNING' },
        makeEvent('StepSucceeded'),
      );

      expect(await stallScore()).not.toBeNull();
    });

    it('clears when the run goes terminal without any step status', async () => {
      // Cancel completes the step with no status at all, and passes the RUN id
      // as the step execution id when there is no current step. A clear keyed
      // on either would miss it; the member is the session, so the run
      // transition alone is enough.
      await atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState(),
        { status: 'RUNNING' },
        makeEvent(),
      );
      await atomicCompleteStep(
        redis,
        TENANT,
        { stepExecutionId: RUN },
        { sessionId: RUN, status: 'CANCELLED', endedAt: Date.now() },
        makeEvent('SessionCancelled'),
      );

      expect(await stallScore()).toBeNull();
    });

    it('clears when a session write fails a run whose step is still scheduled', async () => {
      // The control consumer and failRun both drive the session to FAILED and
      // write no step state at all — a permanently leaked candidate if only the
      // step write could clear it.
      await atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState(),
        { status: 'RUNNING' },
        makeEvent(),
      );
      await updateSessionState(redis, TENANT, RUN, { status: 'FAILED', endedAt: Date.now() });

      expect(await stallScore()).toBeNull();
    });

    it('re-arms a retried step that a failure had cleared', async () => {
      // FAILED → SCHEDULED is the one transition that runs backwards, and the
      // only writer of it is the retry timer.
      await atomicCompleteStep(
        redis,
        TENANT,
        { stepExecutionId: STEP, status: 'FAILED', endedAt: Date.now() },
        { sessionId: RUN, status: 'RUNNING' },
        makeEvent('StepFailed'),
      );
      expect(await stallScore()).toBeNull();

      const scheduledAt = Date.now();
      await updateStepState(redis, TENANT, STEP, {
        sessionId: RUN,
        status: 'SCHEDULED',
        attempt: 2,
        scheduledAt,
      });

      expect(await stallScore()).toBe(scheduledAt + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS);
    });

    it('re-arms a parked step woken back to STARTED', async () => {
      await atomicCompleteStep(
        redis,
        TENANT,
        { stepExecutionId: STEP, status: 'PAUSED', endedAt: Date.now() },
        { sessionId: RUN, status: 'WAITING_ON_CHILD' },
        makeEvent('SessionPaused'),
      );
      expect(await stallScore()).toBeNull();

      const before = Date.now();
      await updateStepState(redis, TENANT, STEP, { sessionId: RUN, status: 'STARTED' });

      const score = await stallScore();
      expect(score).not.toBeNull();
      expect(score!).toBeGreaterThanOrEqual(before + STEP_STARTED_DEAD_EXECUTOR_GRACE_MS);
    });

    it('arms on setStepState so a step restored from a snapshot is watched', async () => {
      await setStepState(redis, makeStepState({ status: 'STARTED', startedAt: CREATED_AT }));

      expect(await stallScore()).toBe(CREATED_AT + STEP_STARTED_DEAD_EXECUTOR_GRACE_MS);
    });

    it('peeks only what is due, oldest first, and refreshes in place', async () => {
      await atomicScheduleStep(
        redis,
        TENANT,
        RUN,
        makeStepState(),
        { status: 'RUNNING' },
        makeEvent(),
      );

      const notYet = CREATED_AT - 1;
      expect(await peekDueStepStallCandidates(redis, 10, notYet)).toEqual([]);

      const due = await peekDueStepStallCandidates(redis, 10, Date.now());
      expect(due.map((c) => c.sessionId)).toEqual([RUN]);
      // The peek is non-destructive: an instance that does not own this session
      // must be able to skip it without hiding it from the one that does.
      expect(await stallScore()).not.toBeNull();

      const now = Date.now();
      await refreshStepStallCandidate(redis, TENANT, RUN, now + STEP_STALL_SCAN_INTERVAL_MS);
      expect(await peekDueStepStallCandidates(redis, 10, now)).toEqual([]);
    });

    it('does not resurrect a candidate that was cleared between peek and refresh', async () => {
      await refreshStepStallCandidate(redis, TENANT, RUN, Date.now());
      expect(await stallScore()).toBeNull();
    });

    it('drops a candidate outright', async () => {
      await setStepState(redis, makeStepState());
      const [c] = await peekDueStepStallCandidates(redis, 10, Date.now() + 3_600_000);
      await dropStepStallCandidate(redis, TENANT, RUN, c!.dueAtMs);
      expect(await stallScore()).toBeNull();
    });
  });

  describe('queued-session index', () => {
    it('arms on session creation and clears when the run starts', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      expect(await queuedScore()).toBe(CREATED_AT);

      await atomicCreateSession(
        redis,
        makeRunState({ status: 'RUNNING' }),
        makeStepState(),
        makeEvent('SessionStarted'),
        makeEvent(),
      );
      expect(await queuedScore()).toBeNull();
    });

    it('clears when the run pauses at creation instead of starting', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      await atomicCreateSession(
        redis,
        makeRunState({ status: 'PAUSED' }),
        makeStepState({ status: 'PAUSED' }),
        makeEvent('SessionStarted'),
        makeEvent(),
      );

      expect(await queuedScore()).toBeNull();
    });

    it('clears on the STALLED transition the watchdog itself writes', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      await updateSessionState(redis, TENANT, RUN, { status: 'STALLED', endedAt: Date.now() });

      expect(await queuedScore()).toBeNull();
    });

    it('leaves the index alone for a patch that carries no status', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      await updateSessionState(redis, TENANT, RUN, { currentStepExecutionId: STEP });

      expect(await queuedScore()).toBe(CREATED_AT);
    });

    it('claims only what is past the caller cutoff and leases it', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));

      expect(await claimDueQueuedSessions(redis, CREATED_AT - 1, 10)).toEqual([]);

      const claimed = await claimDueQueuedSessions(redis, CREATED_AT, 10);
      expect(claimed).toEqual([{ tenantId: TENANT, sessionId: RUN }]);

      // A second instance in the same tick gets nothing: the lease moved the
      // score past the cutoff, so exactly one of them writes STALLED.
      expect(await claimDueQueuedSessions(redis, CREATED_AT, 10)).toEqual([]);
      expect(await queuedScore()).toBeGreaterThan(CREATED_AT);
    });

    it('re-arms a leased candidate back to its creation time', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      await claimDueQueuedSessions(redis, CREATED_AT, 10);
      await rearmQueuedSessionCandidate(redis, TENANT, RUN, CREATED_AT);

      expect(await queuedScore()).toBe(CREATED_AT);
    });

    it('does not resurrect a candidate that started while the claim was held', async () => {
      await rearmQueuedSessionCandidate(redis, TENANT, RUN, CREATED_AT);
      expect(await queuedScore()).toBeNull();
    });

    it('drops a candidate outright', async () => {
      await setSessionState(redis, makeRunState({ status: 'QUEUED' }));
      await dropQueuedSessionCandidate(redis, TENANT, RUN);
      expect(await queuedScore()).toBeNull();
    });
  });

  describe('delegation-supervision index', () => {
    it('arms when the parent enters the wait and clears when it is released', async () => {
      const before = Date.now();
      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      const score = await supervisionScore();
      expect(score).not.toBeNull();
      expect(score!).toBeGreaterThanOrEqual(before + DELEGATION_SUPERVISION_CHECK_INTERVAL_MS);

      await updateSessionState(redis, TENANT, RUN, { status: 'RUNNING' });
      expect(await supervisionScore()).toBeNull();
    });

    it('stays armed while a sibling release writes no status', async () => {
      // Releasing one of several children writes the delegation fields and no
      // status, because the parent is still waiting on the others. A rule that
      // read a missing status as "not waiting" would unarm the parent on the
      // first sibling and leave the rest unsupervised.
      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      await updateSessionState(redis, TENANT, RUN, {
        waitingForChildSessionIds: ['child-b'],
      });

      expect(await supervisionScore()).not.toBeNull();
    });

    it('clears on every terminal transition, whichever primitive writes it', async () => {
      for (const write of [
        () => updateSessionState(redis, TENANT, RUN, { status: 'FAILED', endedAt: Date.now() }),
        () => setSessionState(redis, makeRunState({ status: 'CANCELLED' })),
        () =>
          atomicCompleteStep(
            redis,
            TENANT,
            { stepExecutionId: STEP, status: 'SUCCEEDED' },
            { sessionId: RUN, status: 'SUCCEEDED' },
            makeEvent('StepSucceeded'),
          ),
      ]) {
        await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
        expect(await supervisionScore()).not.toBeNull();
        await write();
        expect(await supervisionScore()).toBeNull();
      }
    });

    it('arms from a session restored out of Postgres, not just from the live transition', async () => {
      // A parent can come back from the durable snapshot hours after its hot
      // state expired, through `setSessionState` and no orchestrator call site.
      await setSessionState(redis, makeRunState({ status: 'WAITING_ON_CHILD' }));
      expect(await supervisionScore()).not.toBeNull();
    });

    it('re-arms when a relayed question is answered', async () => {
      // The parent parks at PAUSED to relay the child's question, which clears
      // supervision on purpose — it is blocked on a human, not on the child.
      // The answer re-enters the wait, and that write has to bring it back.
      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      await updateSessionState(redis, TENANT, RUN, {
        status: 'PAUSED',
        delegationPauseSource: 'child_input',
      });
      expect(await supervisionScore()).toBeNull();

      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      expect(await supervisionScore()).not.toBeNull();
    });

    it('peeks only what is due and pushes a healthy wait forward', async () => {
      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      expect(await peekDueDelegationSupervisionCandidates(redis, 10, Date.now())).toEqual([]);

      const due = await peekDueDelegationSupervisionCandidates(
        redis,
        10,
        Date.now() + DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
      );
      expect(due.map((c) => c.sessionId)).toEqual([RUN]);
      // Non-destructive: an instance that does not own this parent must be able
      // to skip it without hiding it from the one that does.
      expect(await supervisionScore()).not.toBeNull();

      const now = Date.now();
      await refreshDelegationSupervisionCandidate(redis, TENANT, RUN, now + 3_600_000);
      expect(
        await peekDueDelegationSupervisionCandidates(
          redis,
          10,
          now + DELEGATION_SUPERVISION_CHECK_INTERVAL_MS,
        ),
      ).toEqual([]);
    });

    it('does not resurrect a parent released between peek and refresh', async () => {
      await refreshDelegationSupervisionCandidate(redis, TENANT, RUN, Date.now());
      expect(await supervisionScore()).toBeNull();
    });

    it('drops only the score the sweep read', async () => {
      await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });
      const armed = (await supervisionScore())!;

      expect(await dropDelegationSupervisionCandidate(redis, TENANT, RUN, armed - 1)).toBe(false);
      expect(await supervisionScore()).toBe(armed);

      expect(await dropDelegationSupervisionCandidate(redis, TENANT, RUN, armed)).toBe(true);
      expect(await supervisionScore()).toBeNull();
    });

    it('carries over a parent that was already waiting when the index appeared', async () => {
      // The population the index would otherwise never see: waiting is the one
      // state whose next write is the release supervision exists to guarantee.
      await setSessionState(redis, makeRunState({ status: 'WAITING_ON_CHILD' }));
      await markRunActive(redis, TENANT, RUN);
      await redis.del(StreamKeys.delegationSupervisionCandidatesKey);

      expect(await carryOverWaitingParents(redis)).toBe(1);
      expect(await supervisionScore()).not.toBeNull();
    });

    it('carries over nothing for an active run that is not waiting', async () => {
      await setSessionState(redis, makeRunState({ status: 'RUNNING' }));
      await markRunActive(redis, TENANT, RUN);

      expect(await carryOverWaitingParents(redis)).toBe(0);
      expect(await supervisionScore()).toBeNull();
    });
  });

  it('leaves no candidate behind when a session is purged', async () => {
    // A purged session that keeps a member is claimed, read and discarded on
    // every cycle forever — an idle cost that grows with deleted sessions.
    await atomicCreateSession(
      redis,
      makeRunState({ status: 'QUEUED', lastActivityAt: 1000 }),
      makeStepState(),
      makeEvent('SessionStarted'),
      makeEvent(),
    );
    await setSessionState(redis, makeRunState({ status: 'QUEUED', lastActivityAt: 1000 }));
    await setStepState(redis, makeStepState());
    await updateSessionState(redis, TENANT, RUN, { status: 'WAITING_ON_CHILD' });

    await deleteSessionResidue(redis, TENANT, RUN);

    expect(await stallScore()).toBeNull();
    expect(await queuedScore()).toBeNull();
    expect(await supervisionScore()).toBeNull();
    expect(await redis.zscore(StreamKeys.projectionCandidatesKey, MEMBER)).toBeNull();
    expect(await redis.zscore(StreamKeys.sessionMetadataCandidatesKey, MEMBER)).toBeNull();
    expect(await redis.zscore(StreamKeys.sessionMetadataDueKey, MEMBER)).toBeNull();
    expect(await redis.zscore(StreamKeys.sessionMetadataLeasesKey, MEMBER)).toBeNull();
    expect(await redis.hget(StreamKeys.sessionMetadataAttemptsKey, MEMBER)).toBeNull();
  });
});

describe('step-stall due time', () => {
  it('is the smallest grace that could apply, not the one in force right now', () => {
    // Which SCHEDULED grace applies depends on executor liveness, which the
    // writer cannot know and which can change under it. Scoring with the
    // three-minute pickup grace would silently turn ten-second dead-executor
    // detection into three-minute detection.
    const step = { status: 'SCHEDULED', scheduledAt: 1000 } as Partial<StepHotState>;
    expect(stepStallEarliestReapAtMs(step, 0)).toBe(1000 + STEP_SCHEDULED_DEAD_EXECUTOR_GRACE_MS);
  });

  it('falls back to now for a patch that carries no timestamps', () => {
    expect(stepStallEarliestReapAtMs({ status: 'STARTED' }, 5000)).toBe(
      5000 + STEP_STARTED_DEAD_EXECUTOR_GRACE_MS,
    );
  });

  it('has no due time for a status outside the watchdog shape', () => {
    expect(stepStallEarliestReapAtMs({ status: 'PAUSED' }, 0)).toBeNull();
    expect(stepStallEarliestReapAtMs({}, 0)).toBeNull();
  });

  it('never re-checks a healthy candidate sooner than a scan interval', () => {
    const step = {
      status: 'STARTED',
      startedAt: 0,
      scheduledAt: 0,
    } as unknown as StepHotState;
    expect(stepStallNextCheckAtMs(step, 1_000_000)).toBe(1_000_000 + STEP_STALL_SCAN_INTERVAL_MS);
  });
});

describe('candidate index writers', () => {
  async function readSources(): Promise<Array<{ file: string; src: string }>> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const srcRoot = new URL('../', import.meta.url).pathname;

    async function* walk(dir: string): AsyncGenerator<string> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.name.endsWith('.ts')) yield full;
      }
    }

    const out: Array<{ file: string; src: string }> = [];
    for await (const file of walk(srcRoot)) {
      if (file.includes('__tests__')) continue;
      out.push({ file: path.relative(srcRoot, file), src: await fs.readFile(file, 'utf8') });
    }
    return out;
  }

  it.each([
    ['stepStallCandidatesKey', 'hotState/stepStallCandidates.ts'],
    ['queuedSessionCandidatesKey', 'hotState/queuedSessionCandidates.ts'],
    ['projectionCandidatesKey', 'hotState/projectionCandidates.ts'],
    ['projectionOrderKey', 'hotState/projectionCandidates.ts'],
    ['projectionLeasesKey', 'hotState/projectionCandidates.ts'],
    ['delegationSupervisionCandidatesKey', 'hotState/delegationSupervisionCandidates.ts'],
  ])('names %s in exactly one module', async (key, owner) => {
    // Two ways to write one index is how the atomic writers and the projection
    // worker drifted apart, and the drift was invisible until runs stopped
    // reaching Postgres.
    const offenders = (await readSources())
      .filter(({ file, src }) => file !== owner && src.includes(key))
      .map(({ file }) => file);

    expect(
      offenders,
      `Reach ${key} through the helpers in ${owner} rather than naming it directly.`,
    ).toEqual([]);
  });

  it('arms every module that serializes hot state into a hash', async () => {
    // The serializers are the only way a SessionHotState or StepHotState
    // reaches a Redis hash, so a module that calls one and arms nothing is a
    // write the watchdogs cannot see.
    const offenders = (await readSources())
      .filter(({ file, src }) => {
        if (file === 'hotState/serialization.ts') return false;
        if (!src.includes('serializeForHash')) return false;
        return !/syncStepStallCandidateFor|syncQueuedSessionCandidate/.test(src);
      })
      .map(({ file }) => file);

    expect(
      offenders,
      'A writer of session or step hot state must arm the candidate indexes inside the pipeline it already issues.',
    ).toEqual([]);
  });

  it('arms the projection candidate wherever it writes a session hash', async () => {
    // The oldest index, and the one the newer guards could not see: they assert
    // the newer indexes agree with each other, which says nothing about the one
    // they were all modelled on. Every durable field of a session reaches
    // Postgres through this candidate, so a session write that does not arm it
    // leaves the durable row stale with nothing pointing at it — and the only
    // thing standing between that and a caller remembering `markSessionDirty`
    // is this assertion.
    const offenders = (await readSources())
      .filter(({ file, src }) => {
        if (file === 'hotState/serialization.ts') return false;
        if (file === 'hotState/projectionCandidates.ts') return false;
        if (!src.includes('serializeForHash')) return false;
        if (!src.includes('sessionStateKey')) return false;
        return !src.includes('markProjectionCandidate');
      })
      .map(({ file }) => file);

    expect(
      offenders,
      'A writer of session hot state must arm the projection candidate inside the pipeline it already issues.',
    ).toEqual([]);
  });

  it('arms the conversation clock and the metadata candidate from the same field', async () => {
    // The two are one statement — a person spoke here — and splitting them is
    // how a conversation acquires a sort position it never gets a name for, or
    // a name nobody can find because it sorts by when it opened. A writer that
    // sets `lastActivityAt` without arming has made exactly that split.
    const offenders = (await readSources())
      .filter(({ file, src }) => {
        if (file === 'hotState/sessionMetadataCandidates.ts') return false;
        if (file === 'hotState/schemas.ts') return false;
        if (!src.includes('lastActivityAt')) return false;
        return !src.includes('syncSessionMetadataCandidate');
      })
      .map(({ file }) => file);

    expect(
      offenders,
      'A writer that advances the conversation clock must arm the metadata candidate in the same pipeline.',
    ).toEqual([]);
  });

  it('arms the delegation-supervision index wherever it arms the queued one', async () => {
    // Both are derived from the same field of the same write — `status` on a
    // session patch — so their writer sets are identical by construction. A
    // writer that arms one and not the other is a transition the sweep on the
    // other side cannot see, and nothing at runtime reports the gap: that is
    // exactly how the earlier indexes lost three writers at once.
    const offenders = (await readSources())
      .filter(({ file, src }) => {
        if (file.startsWith('hotState/queuedSessionCandidates')) return false;
        if (!src.includes('syncQueuedSessionCandidate')) return false;
        return !src.includes('syncDelegationSupervisionCandidate');
      })
      .map(({ file }) => file);

    expect(
      offenders,
      'A session write that derives the queued candidate must derive the supervision candidate too.',
    ).toEqual([]);
  });
});
