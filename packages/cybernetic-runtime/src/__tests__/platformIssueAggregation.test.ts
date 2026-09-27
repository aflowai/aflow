import { describe, expect, it } from 'vitest';
import type { StagedChange, TenantId } from '@aflow/schemas';
import { PLATFORM_ISSUE_OCCURRENCE_CAP, StagedChangeSchema } from '@aflow/schemas';
import {
  appendPlatformIssueOccurrence,
  extractPlatformIssueSubject,
  findOpenPlatformIssueForSubject,
  type PlatformIssueSubject,
} from '../stagedChange/platformIssueAggregation.js';
import { PROPOSAL_PLATFORM_DIR } from '../stagedChange/resolveProposalRoute.js';

const TENANT = 'a0000000-0000-0000-0000-000000000001' as TenantId;
const SPACE = '22222222-3333-4444-5555-666666666666';
const COACH_SESSION = '99999999-9999-4999-8999-999999999999';

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function buildIssueDoc(opts: {
  subjectKind?: 'skill' | 'runtime' | 'evalRunner' | 'budget' | 'other';
  subjectId?: string;
  targetSlug?: string;
  status?: StagedChange['status'];
  occurrences?: StagedChange['occurrences'];
}): StagedChange {
  const now = new Date().toISOString();
  return StagedChangeSchema.parse({
    id: nextId(),
    kind: 'platform_issue',
    source: 'coach',
    status: opts.status ?? 'proposed',
    targetWorkflowSlug: opts.targetSlug ?? 'kaggle-optimizer',
    proposal: {
      summary: 'Platform issue report',
      rationale: 'Observed a platform-side defect.',
      confidence: 'medium',
      ops: [
        {
          op: 'platform_issue',
          subjectKind: opts.subjectKind ?? 'runtime',
          ...(opts.subjectId !== undefined ? { subjectId: opts.subjectId } : {}),
          summary: 'cancel surfaced as transient failure',
        },
      ],
    },
    evidence: { sourceSessionIds: [COACH_SESSION] },
    authorityLevel: 'require_operator',
    resolutionRoute: 'platform_issue',
    proposedAt: now,
    expiresAt: now,
    coachSessionId: COACH_SESSION,
    ...(opts.occurrences ? { occurrences: opts.occurrences } : {}),
  });
}

/** Minimal in-memory doc repo — only the surface the matcher consumes. */
function fakeRepo(docs: Map<string, StagedChange>) {
  return {
    list: async (options: { pathPrefix?: string }) =>
      [...docs.keys()]
        .filter((p) => options.pathPrefix === undefined || p.startsWith(options.pathPrefix))
        .map((p) => ({ path: p })),
    getByPath: async (path: string) => {
      const staged = docs.get(path);
      return staged ? { inlineContent: JSON.stringify(staged) } : null;
    },
  } as never;
}

function docPath(staged: StagedChange): string {
  return `${PROPOSAL_PLATFORM_DIR}/${staged.id}.json`;
}

function occurrence(runId: string, summary = 'seen again') {
  return { runId, observedAt: new Date().toISOString(), summary };
}

/**
 * Simulate the propose handler's aggregation decision: absorb into an open
 * match (append + write-back) or found a new doc with one occurrence.
 */
async function propose(
  docs: Map<string, StagedChange>,
  opts: { subjectKind?: 'skill' | 'runtime'; subjectId?: string; targetSlug?: string },
  runId: string,
): Promise<StagedChange> {
  const candidate = buildIssueDoc(opts);
  const subject = extractPlatformIssueSubject(
    candidate.proposal.ops,
    candidate.targetWorkflowSlug,
  ) as PlatformIssueSubject;
  const existing = await findOpenPlatformIssueForSubject({
    docRepo: fakeRepo(docs),
    tenantId: TENANT,
    spaceId: SPACE,
    subject,
  });
  if (existing) {
    const updated = appendPlatformIssueOccurrence(existing.staged, occurrence(runId));
    docs.set(existing.docPath, updated);
    return updated;
  }
  const founded = { ...candidate, occurrences: [occurrence(runId)] };
  docs.set(docPath(founded), founded);
  return founded;
}

describe('extractPlatformIssueSubject', () => {
  it('uses subjectId when the op names one, else the target slug', () => {
    const withId = buildIssueDoc({ subjectId: 'kaggle-mcp' });
    expect(extractPlatformIssueSubject(withId.proposal.ops, withId.targetWorkflowSlug)).toEqual({
      subjectKind: 'runtime',
      identity: 'kaggle-mcp',
    });
    const withoutId = buildIssueDoc({});
    expect(
      extractPlatformIssueSubject(withoutId.proposal.ops, withoutId.targetWorkflowSlug),
    ).toEqual({ subjectKind: 'runtime', identity: 'kaggle-optimizer' });
  });

  it('returns null when there is no platform_issue op', () => {
    expect(
      extractPlatformIssueSubject(
        [{ op: 'update_outcome_threshold', taskId: 't', threshold: {}, rationale: 'x' }] as never,
        'some-skill',
      ),
    ).toBeNull();
  });
});

describe('aggregation-on-propose', () => {
  it('two platform_issue proposals for the same subject+skill yield ONE open document with two occurrences', async () => {
    const docs = new Map<string, StagedChange>();
    const first = await propose(docs, { subjectKind: 'runtime' }, 'run-1');
    const second = await propose(docs, { subjectKind: 'runtime' }, 'run-2');

    expect(docs.size).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.occurrences).toHaveLength(2);
    expect(second.occurrences?.map((o) => o.runId)).toEqual(['run-1', 'run-2']);
  });

  it('a different subject yields a separate document', async () => {
    const docs = new Map<string, StagedChange>();
    const a = await propose(docs, { subjectKind: 'runtime' }, 'run-1');
    const b = await propose(docs, { subjectKind: 'runtime', subjectId: 'kaggle-mcp' }, 'run-2');

    expect(docs.size).toBe(2);
    expect(b.id).not.toBe(a.id);
    expect(a.occurrences).toHaveLength(1);
    expect(b.occurrences).toHaveLength(1);
  });

  it('proposing after dismissal yields a fresh document (dismissed docs never absorb)', async () => {
    const docs = new Map<string, StagedChange>();
    const dismissed = buildIssueDoc({ status: 'dismissed' });
    docs.set(docPath(dismissed), dismissed);

    const reRaised = await propose(docs, { subjectKind: 'runtime' }, 'run-3');

    expect(reRaised.id).not.toBe(dismissed.id);
    expect(docs.size).toBe(2);
    expect(reRaised.occurrences).toHaveLength(1);
  });

  it('the occurrence list is capped by the named knob (latest kept)', () => {
    const base = buildIssueDoc({
      occurrences: Array.from({ length: PLATFORM_ISSUE_OCCURRENCE_CAP }, (_, i) =>
        occurrence(`run-${String(i)}`),
      ),
    });
    const appended = appendPlatformIssueOccurrence(base, occurrence('run-newest'));
    expect(appended.occurrences).toHaveLength(PLATFORM_ISSUE_OCCURRENCE_CAP);
    expect(appended.occurrences?.at(-1)?.runId).toBe('run-newest');
    expect(appended.occurrences?.[0]?.runId).toBe('run-1');
  });

  it('aggregated documents still round-trip the StagedChange schema', async () => {
    const docs = new Map<string, StagedChange>();
    await propose(docs, { subjectKind: 'runtime' }, 'run-1');
    const updated = await propose(docs, { subjectKind: 'runtime' }, 'run-2');
    expect(StagedChangeSchema.parse(JSON.parse(JSON.stringify(updated)))).toBeTruthy();
  });
});
