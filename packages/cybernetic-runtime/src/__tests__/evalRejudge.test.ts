/**
 * D9 re-judge planning: replay verdicts are keyed by the CURRENT
 * judgeVersion — a rubric edit yields a new version and re-judges every
 * labeled subject, while unchanged versions skip as already-on-record; the
 * subject≠judge rule holds on the replay path too.
 */
import { describe, expect, it } from 'vitest';
import {
  GoldenCaseRevisionSchema,
  type GoldenCaseRevision,
  type JudgeRubricEntry,
} from '@aflow/schemas';
import { planRejudgeSubjects, rejudgeSubjectKey, type RejudgeSubject } from '../evalRejudge.js';
import { computeJudgeVersion } from '../judgeVersion.js';

const DATASET_ID = '00000000-0000-4000-8000-00000000d5e7';
const REV_A = '00000000-0000-4000-8000-0000000000a1';

function revisionWithRubric(rubric: readonly JudgeRubricEntry[]): GoldenCaseRevision {
  return GoldenCaseRevisionSchema.parse({
    revisionId: REV_A,
    caseId: '00000000-0000-4000-8000-0000000000c1',
    datasetId: DATASET_ID,
    addedInVersion: 1,
    status: 'active',
    case: {
      caseId: '00000000-0000-4000-8000-0000000000c1',
      datasetId: DATASET_ID,
      title: 'Case A',
      stratum: { scenario: 'happy-path', direction: 'should_succeed', tier: 'regression' },
      trigger: { inputs: {} },
      fixture: { tier: 'seeded', learnings: 'none' },
      expectations: [{ kind: 'terminal', runStatus: 'completed' }],
      rubrics: [{ kind: 'case_local', criterion: { type: 'judge', name: 'clarity', rubric } }],
      provenance: { source: 'curated', workflowRevision: 1 },
    },
  });
}

const RUBRIC_V1: JudgeRubricEntry[] = [
  { criterion: 'clear summary', scale: 'binary', description: 'The summary is legible.' },
];
const RUBRIC_V2: JudgeRubricEntry[] = [
  { criterion: 'clear summary', scale: 'binary', description: 'The summary cites its sources.' },
];

const SUBJECTS: RejudgeSubject[] = [
  { batchId: 'batch-1', caseRevisionId: REV_A, trial: 1, runId: 'run-1', scopeKey: 'case_local' },
  { batchId: 'batch-1', caseRevisionId: REV_A, trial: 2, runId: 'run-2', scopeKey: 'case_local' },
];

describe('planRejudgeSubjects — version keying', () => {
  it('skips subjects already holding a verdict at the CURRENT version', () => {
    const revisions = new Map([[REV_A, revisionWithRubric(RUBRIC_V1)]]);
    const currentVersion = computeJudgeVersion(RUBRIC_V1, 'judge-model');
    const plans = planRejudgeSubjects({
      subjects: SUBJECTS,
      revisionsById: revisions,
      suite: null,
      criterionId: 'clarity',
      spaceJudgeModel: 'judge-model',
      subjectModelRefs: ['subject-model'],
      existingVerdictKeys: new Set([`${rejudgeSubjectKey(SUBJECTS[0]!)} ${currentVersion}`]),
    });
    expect(plans.map((p) => p.action)).toEqual(['skip_existing', 'judge']);
    expect(plans[0]!.action === 'skip_existing' && plans[0].judgeVersion).toBe(currentVersion);
  });

  it('a rubric edit changes the version, so the same subjects re-judge under the NEW key', () => {
    const oldVersion = computeJudgeVersion(RUBRIC_V1, 'judge-model');
    const revisions = new Map([[REV_A, revisionWithRubric(RUBRIC_V2)]]);
    const plans = planRejudgeSubjects({
      subjects: SUBJECTS,
      revisionsById: revisions,
      suite: null,
      criterionId: 'clarity',
      spaceJudgeModel: 'judge-model',
      subjectModelRefs: ['subject-model'],
      existingVerdictKeys: new Set(SUBJECTS.map((s) => `${rejudgeSubjectKey(s)} ${oldVersion}`)),
    });
    expect(plans.map((p) => p.action)).toEqual(['judge', 'judge']);
    const newVersion = computeJudgeVersion(RUBRIC_V2, 'judge-model');
    expect(newVersion).not.toBe(oldVersion);
    for (const plan of plans) {
      expect(plan.action === 'judge' && plan.judgeVersion).toBe(newVersion);
    }
  });

  it('a judge-model change alone also re-keys the version', () => {
    expect(computeJudgeVersion(RUBRIC_V1, 'judge-model')).not.toBe(
      computeJudgeVersion(RUBRIC_V1, 'other-judge-model'),
    );
  });
});

describe('planRejudgeSubjects — D8 rules on the replay path', () => {
  it('refuses per subject when the judge model equals the subject model', () => {
    const revisions = new Map([[REV_A, revisionWithRubric(RUBRIC_V1)]]);
    const plans = planRejudgeSubjects({
      subjects: SUBJECTS.slice(0, 1),
      revisionsById: revisions,
      suite: null,
      criterionId: 'clarity',
      spaceJudgeModel: 'subject-model',
      subjectModelRefs: ['subject-model'],
      existingVerdictKeys: new Set(),
    });
    expect(plans[0]!.action).toBe('error');
    expect(plans[0]!.action === 'error' && plans[0].message).toContain('modelDefaults.judge');
  });

  it('errors a subject whose case has no rubric slot for the criterion', () => {
    const revisions = new Map([[REV_A, revisionWithRubric(RUBRIC_V1)]]);
    const plans = planRejudgeSubjects({
      subjects: SUBJECTS.slice(0, 1),
      revisionsById: revisions,
      suite: null,
      criterionId: 'unknown-criterion',
      spaceJudgeModel: 'judge-model',
      subjectModelRefs: ['subject-model'],
      existingVerdictKeys: new Set(),
    });
    expect(plans[0]!.action).toBe('error');
  });

  it('a same-named slot at a DIFFERENT scope never resolves — the subject scope must match', () => {
    const revisions = new Map([[REV_A, revisionWithRubric(RUBRIC_V1)]]);
    const plans = planRejudgeSubjects({
      subjects: [{ ...SUBJECTS[0]!, scopeKey: 'goal' }],
      revisionsById: revisions,
      suite: null,
      criterionId: 'clarity',
      spaceJudgeModel: 'judge-model',
      subjectModelRefs: ['subject-model'],
      existingVerdictKeys: new Set(),
    });
    expect(plans[0]!.action).toBe('error');
    expect(plans[0]!.action === 'error' && plans[0].message).toContain("scope 'goal'");
  });

  it('rejudgeSubjectKey separates same-trial subjects at different scopes', () => {
    expect(rejudgeSubjectKey(SUBJECTS[0]!)).not.toBe(
      rejudgeSubjectKey({ ...SUBJECTS[0]!, scopeKey: 'goal' }),
    );
  });
});
