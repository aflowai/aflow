/**
 * A proposal names the session or run that wrote it. The card shows the
 * conversation that session belongs to, and the withdraw rule reads the same
 * conversation. Every field comes from the record, whatever skill it targets.
 */
import { describe, expect, it } from 'vitest';
import type { StagedChange } from '@aflow/schemas';
import {
  conversationFor,
  isProposalOfConversation,
  provenanceOf,
  type ConversationLookup,
  type ConversationSessionRow,
} from '../proposalProvenance.js';

const HELMSMAN = 'aaaaaaaa-0000-4000-8000-000000000001';
const DELEGATE = 'aaaaaaaa-0000-4000-8000-000000000002';
const COACH = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000004';
const RUN_ID = 'run-7f3e';
const SENTINEL = '00000000-0000-0000-0000-000000000000';

function staged(overrides: Partial<StagedChange>): StagedChange {
  return {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    kind: 'workflow_refinement',
    status: 'proposed',
    targetWorkflowSlug: 'coastal-weather-alerts',
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
    row(HELMSMAN, { title: 'storm warnings', manualTitle: 'Coastal storm warnings' }),
    row(DELEGATE, { parentSessionId: HELMSMAN }),
    row(COACH, { title: 'Review of run 7f3e' }),
    row(OTHER, { title: 'Garden watering' }),
  ]),
  runSessions: new Map([[RUN_ID, HELMSMAN]]),
};

describe('conversationFor', () => {
  it('names the conversation that patched, by the title a person gave it', () => {
    expect(conversationFor(staged({ coachSessionId: HELMSMAN }), lookup)).toEqual({
      sessionId: HELMSMAN,
      title: 'Coastal storm warnings',
    });
  });

  it('resolves a delegated session to the conversation above it', () => {
    expect(conversationFor(staged({ coachSessionId: DELEGATE }), lookup)?.sessionId).toBe(HELMSMAN);
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

describe('isProposalOfConversation', () => {
  it('matches the conversation a delegated session patched under', () => {
    const sc = staged({ source: 'agent_patch', coachSessionId: DELEGATE });
    expect(isProposalOfConversation(sc, HELMSMAN, lookup)).toBe(true);
    expect(isProposalOfConversation(sc, DELEGATE, lookup)).toBe(true);
  });

  it('refuses another conversation', () => {
    const sc = staged({ source: 'agent_patch', coachSessionId: DELEGATE });
    expect(isProposalOfConversation(sc, OTHER, lookup)).toBe(false);
  });

  it('matches only the recorded id when the space holds neither session', () => {
    const unknown = 'cccccccc-0000-4000-8000-000000000009';
    const sc = staged({ source: 'agent_patch', coachSessionId: unknown });
    const empty: ConversationLookup = { sessions: new Map(), runSessions: new Map() };
    expect(isProposalOfConversation(sc, unknown, empty)).toBe(true);
    expect(isProposalOfConversation(sc, OTHER, empty)).toBe(false);
  });
});

describe('provenanceOf', () => {
  const conversation = { sessionId: HELMSMAN, title: 'Coastal storm warnings' };

  it('labels a Helmsman patch on any skill by the role the record names', () => {
    const sc = staged({ source: 'agent_patch', proposedBy: 'Helmsman' });
    expect(provenanceOf(sc, conversation, 'Coastal weather alerts')).toEqual({
      source: 'agent_patch',
      sourceLabel: 'Helmsman patch',
      conversation,
      authorRole: 'Helmsman',
      authorId: HELMSMAN,
      target: { slug: 'coastal-weather-alerts', name: 'Coastal weather alerts' },
      withdrawnBy: null,
    });
  });

  it("labels another agent's patch by that agent, not the Helmsman", () => {
    const sc = staged({ source: 'agent_patch', proposedBy: 'Forecast analyst' });
    expect(provenanceOf(sc, null)).toMatchObject({
      sourceLabel: 'Forecast analyst patch',
      authorRole: 'Forecast analyst',
    });
  });

  it('labels a Coach review, a composed skill and a platform issue from the record', () => {
    expect(provenanceOf(staged({ source: 'coach', coachSessionId: COACH }), null)).toMatchObject({
      sourceLabel: 'Coach review',
      authorRole: 'Coach',
    });
    expect(
      provenanceOf(staged({ kind: 'skill_compose', coachSessionId: RUN_ID }), null),
    ).toMatchObject({
      source: 'compose_skill',
      sourceLabel: 'Composed skill',
      authorRole: null,
      authorId: RUN_ID,
    });
    expect(
      provenanceOf(staged({ source: 'coach', resolutionRoute: 'platform_issue' }), null),
    ).toMatchObject({ source: 'coach', sourceLabel: 'Platform issue' });
  });

  it('names the agent that withdrew it, which need not be the author', () => {
    const sc = staged({
      source: 'agent_patch',
      proposedBy: 'Helmsman',
      status: 'withdrawn',
      withdrawnBy: 'Coach',
    });
    expect(provenanceOf(sc, null).withdrawnBy).toBe('Coach');
    expect(provenanceOf({ ...sc, status: 'proposed' }, null).withdrawnBy).toBeNull();
  });

  it('leaves the target out of a proposal that names no skill', () => {
    const sc = staged({});
    delete sc.targetWorkflowSlug;
    expect(provenanceOf(sc, null).target).toBeNull();
  });
});
