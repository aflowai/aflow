/**
 * A proposal names the session or run that wrote it. The card shows the
 * conversation that session belongs to, by title, so the reader can open it.
 */
import { describe, expect, it } from 'vitest';
import type { StagedChange } from '@aflow/schemas';
import {
  conversationFor,
  provenanceOf,
  type ConversationLookup,
  type ConversationSessionRow,
} from '../proposalProvenance.js';

const HELMSMAN = 'aaaaaaaa-0000-4000-8000-000000000001';
const RUNNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const COACH = 'aaaaaaaa-0000-4000-8000-000000000003';
const RUN_ID = 'run-7f3e';
const SENTINEL = '00000000-0000-0000-0000-000000000000';

function staged(overrides: Partial<StagedChange>): StagedChange {
  return {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    kind: 'workflow_refinement',
    status: 'proposed',
    proposal: { summary: 's', rationale: 'r', confidence: 'medium', ops: [] },
    evidence: { sourceSessionIds: [] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'tenant_ratification',
    proposedAt: '2026-10-30T09:00:00.000Z',
    expiresAt: '2026-11-06T09:00:00.000Z',
    coachSessionId: HELMSMAN,
    ...overrides,
  } as StagedChange;
}

function row(sessionId: string, fields: Partial<ConversationSessionRow> = {}) {
  return [
    sessionId,
    { sessionId, parentSessionId: null, title: null, manualTitle: null, ...fields },
  ] as const;
}

const lookup: ConversationLookup = {
  sessions: new Map([
    row(HELMSMAN, { title: 'commission-change edits', manualTitle: 'Commission change review' }),
    row(RUNNER, { parentSessionId: HELMSMAN }),
    row(COACH, { title: 'Review of run 7f3e' }),
  ]),
  runSessions: new Map([[RUN_ID, HELMSMAN]]),
};

describe('conversationFor', () => {
  it('names the conversation that patched, by the title a person gave it', () => {
    expect(conversationFor(staged({ coachSessionId: HELMSMAN }), lookup)).toEqual({
      sessionId: HELMSMAN,
      title: 'Commission change review',
    });
  });

  it('resolves a delegated session to the conversation above it', () => {
    expect(conversationFor(staged({ coachSessionId: RUNNER }), lookup)?.sessionId).toBe(HELMSMAN);
  });

  it('resolves a workflow run to the conversation that started it', () => {
    expect(conversationFor(staged({ coachSessionId: RUN_ID }), lookup)?.sessionId).toBe(HELMSMAN);
  });

  it('skips the operator sentinel and reads the evidence sessions next', () => {
    const sc = staged({ coachSessionId: SENTINEL, evidence: { sourceSessionIds: [COACH] } });
    expect(conversationFor(sc, lookup)).toEqual({ sessionId: COACH, title: 'Review of run 7f3e' });
  });

  it('answers null when no conversation in the space holds the session', () => {
    const sc = staged({ coachSessionId: 'cccccccc-0000-4000-8000-000000000009' });
    expect(conversationFor(sc, lookup)).toBeNull();
  });
});

describe('provenanceOf', () => {
  it('takes the source the proposal records, and infers it for an older one', () => {
    expect(provenanceOf(staged({ source: 'agent_patch' }), null).source).toBe('agent_patch');
    expect(provenanceOf(staged({ kind: 'skill_compose' }), null).source).toBe('compose_skill');
  });
});
