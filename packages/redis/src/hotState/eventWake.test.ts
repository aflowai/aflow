/**
 * A wake says "carry on", not "yes".
 *
 * It carries no answer of its own — the message is in the room and the agent
 * reads the room — so it may only advance a run that is waiting for the
 * agent's next turn. Every other pause is waiting for a specific answer from a
 * specific person, and resuming one of those with an empty payload does not
 * decline to answer it, it answers it emptily: a decision-less resume of an
 * approval step reads as approved, so "hmm, not sure about this" would ship
 * the very thing it doubted.
 */
import { describe, it, expect } from 'vitest';
import type { SessionHotState } from './schemas.js';
import type { Redis } from 'ioredis';
import { claimEventDrivenTurn, mayWake } from './eventWake.js';

const STEP = '00000000-0000-4000-8000-0000000000a1';

function paused(over: Partial<SessionHotState> = {}): SessionHotState {
  return { status: 'PAUSED', currentStepExecutionId: STEP, ...over } as SessionHotState;
}

const agentTurn = { operationId: 'ai.agent.turn' };

describe('what a wake may advance', () => {
  it('advances a run waiting for the agent’s next turn', () => {
    expect(mayWake(paused(), agentTurn)).toBe(true);
  });

  it('never answers a pending approval', () => {
    // The pause reason is 'input_required' for both an approval and a chat
    // question, so the operation is what has to decide.
    expect(mayWake(paused(), { operationId: 'user.interaction.approve' })).toBe(false);
  });

  it('never answers a request for input meant for a person', () => {
    expect(mayWake(paused(), { operationId: 'user.interaction.input' })).toBe(false);
  });

  it('leaves a run waiting on a sub-agent’s question alone', () => {
    // The resume would be forwarded to the child, whose room is not this one,
    // so an answer posted here could never reach whoever asked.
    expect(mayWake(paused({ delegationPauseSource: 'child_input' }), agentTurn)).toBe(false);
    expect(mayWake(paused({ delegationPauseSource: 'child_running' }), agentTurn)).toBe(false);
  });

  it('does nothing to a run that is not resting', () => {
    for (const status of ['RUNNING', 'WAITING_ON_CHILD', 'SUCCEEDED', 'FAILED'] as const) {
      expect(mayWake(paused({ status }), agentTurn)).toBe(false);
    }
  });

  it('leaves a session parked on a run it started and waits on', () => {
    expect(
      mayWake(paused({ pauseType: 'external_dependency' }), { operationId: 'workflow.run.start' }),
    ).toBe(false);
  });

  it('refuses when the paused step cannot be identified', () => {
    // Better a message that did not wake anything than a resume aimed at a
    // step nobody could name.
    expect(mayWake(paused(), null)).toBe(false);
    expect(mayWake(paused({ currentStepExecutionId: undefined }), agentTurn)).toBe(false);
  });
});

/** Enough of a Redis for a MULTI of SET NX + INCR, with the window's expiry under the test's hand. */
function fakeRedis(): { redis: Redis; expire: () => void } {
  const store = new Map<string, number>();
  const redis = {
    multi() {
      const ops: Array<() => [null, unknown]> = [];
      const chain = {
        set(key: string, value: string, _ex: 'EX', _seconds: number, _nx: 'NX') {
          ops.push(() => {
            if (store.has(key)) return [null, null];
            store.set(key, Number(value));
            return [null, 'OK'];
          });
          return chain;
        },
        incr(key: string) {
          ops.push(() => {
            const next = (store.get(key) ?? 0) + 1;
            store.set(key, next);
            return [null, next];
          });
          return chain;
        },
        exec() {
          return Promise.resolve(ops.map((op) => op()));
        },
      };
      return chain;
    },
  } as unknown as Redis;
  return { redis, expire: () => store.clear() };
}

describe('event-driven turns per session', () => {
  it('grants turns up to the limit in a window, then refuses until the window passes', async () => {
    const { redis, expire } = fakeRedis();
    const claims = [];
    for (let i = 0; i < 4; i++) {
      claims.push(await claimEventDrivenTurn(redis, 't1', 's1', 3));
    }
    expect(claims).toEqual([true, true, true, false]);

    expect(await claimEventDrivenTurn(redis, 't1', 's2', 3)).toBe(true);

    expire();
    expect(await claimEventDrivenTurn(redis, 't1', 's1', 3)).toBe(true);
  });
});
