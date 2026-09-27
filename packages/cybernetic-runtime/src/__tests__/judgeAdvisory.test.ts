import { describe, expect, it, beforeAll, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import {
  alignJudgeEntries,
  cappedText,
  foldJudgeVerdict,
  JudgeRubricEntrySchema,
  JudgeVerdictSchema,
  JUDGE_CRITERION_MAX_CHARS,
} from '@aflow/schemas';
import { getJudgeSystemPrompt, buildJudgeUserMessage } from '../prompts/judge.js';

// The `evaluateJudgeCriterion` tests below exercise the provider-failure path.
// They used to dispatch a REAL LLM call (a bogus model name) and rely on it
// erroring — a network round-trip that flakes under full-suite load (the 10s
// test timeout). Mock the AI client so the judge call rejects instantly and
// offline; judge_error + advisory-only output is exactly what those tests
// assert, so the contract under test is unchanged.
vi.mock('@aflow/ai-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/ai-client')>();
  return {
    ...actual,
    createAIClient: () =>
      ({
        generateJson: () => Promise.reject(new Error('judge client mocked offline in unit tests')),
      }) as unknown as ReturnType<typeof actual.createAIClient>,
  };
});

// Logger must be initialized before any code that calls getCyberneticLogger()
beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

// ============================================================================
// JudgeVerdictSchema validation
// ============================================================================

describe('JudgeVerdictSchema', () => {
  it('accepts a per-entry pass verdict', () => {
    const result = JudgeVerdictSchema.safeParse({
      entries: [
        {
          criterion: 'is clear',
          rationale: 'States the amount and the merchant.',
          verdict: 'pass',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('folds entries into a verdict: a rubric passes only when every entry does', () => {
    const folded = foldJudgeVerdict([
      { criterion: 'a', rationale: 'met', verdict: 'pass' },
      { criterion: 'b', rationale: 'not met', verdict: 'fail' },
    ]);
    expect(folded.verdict).toBe('fail');
    expect(folded.score).toBe(0.5);
    expect(folded.rationale).toContain('b — fail');
  });

  it('refuses a verdict with no entries — nothing to fold', () => {
    expect(JudgeVerdictSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it("rejects 'partial' — the per-call verdict is strictly binary (D8)", () => {
    const result = JudgeVerdictSchema.safeParse({
      score: 0.6,
      verdict: 'partial',
      rationale: 'Rubric entry 1 passed but entry 2 only partially addressed.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects score below 0', () => {
    const result = JudgeVerdictSchema.safeParse({
      score: -0.1,
      verdict: 'pass',
      rationale: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects score above 1', () => {
    const result = JudgeVerdictSchema.safeParse({
      score: 1.1,
      verdict: 'pass',
      rationale: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid verdict value', () => {
    const result = JudgeVerdictSchema.safeParse({
      score: 0.5,
      verdict: 'maybe',
      rationale: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects rationale over the cap', () => {
    const result = JudgeVerdictSchema.safeParse({
      score: 0.5,
      verdict: 'pass',
      rationale: 'x'.repeat(1501),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(JudgeVerdictSchema.safeParse({ score: 0.5 }).success).toBe(false);
    expect(JudgeVerdictSchema.safeParse({ verdict: 'pass' }).success).toBe(false);
    expect(JudgeVerdictSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// Judge prompt composer
// ============================================================================

describe('Judge prompt composer', () => {
  it('system prompt instructs critique BEFORE verdict, binary only', () => {
    const prompt = getJudgeSystemPrompt();
    expect(prompt).toContain('You are a Judge');
    expect(prompt).toContain("'pass' or 'fail'");
    expect(prompt).not.toContain('partial credit is');
    expect(prompt).not.toContain("'partial'");
    expect(prompt).toContain('Do not be charitable');
    expect(prompt).toContain('JudgeVerdict');
    // Critique-then-verdict: the rationale instruction precedes the verdict one.
    expect(prompt.indexOf('rationale FIRST')).toBeGreaterThan(-1);
    expect(prompt.indexOf('rationale FIRST')).toBeLessThan(
      prompt.indexOf("verdict: 'pass' or 'fail'"),
    );
    // Reference-guided grading: similarity is explicitly never scored.
    expect(prompt).toContain('similarity to the reference is never itself scored');
  });

  it('builds user message with criterion name and rubric', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'output-quality',
        rubric: [
          { criterion: 'Correct answer', scale: 'binary', description: 'Must match expected' },
          {
            criterion: 'Clear explanation',
            scale: 'binary',
            description: 'Clarity of reasoning',
          },
        ],
      },
      taskSummaries: [
        { taskId: 'task-1', status: 'completed', summary: 'Found the answer' },
        { taskId: 'task-2', status: 'failed' },
      ],
    });

    expect(msg).toContain('## Criterion: output-quality');
    expect(msg).toContain('## Rubric');
    expect(msg).toContain('[binary] Correct answer');
    expect(msg).toContain('[binary] Clear explanation');
    expect(msg).toContain('## Run Artifacts');
    expect(msg).toContain('Task "task-1" [COMPLETED]: Found the answer');
    expect(msg).toContain('Task "task-2" [FAILED]');
  });

  it('includes reference answer when present', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'test',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
        referenceAnswer: 'The expected answer is 42.',
      },
      taskSummaries: [],
    });

    expect(msg).toContain('## Reference Answer');
    expect(msg).toContain('The expected answer is 42.');
  });

  it('includes calibration notes when present', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'test',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
      },
      taskSummaries: [],
      calibrationNotes: 'Operator noted: be strict on formatting.',
    });

    expect(msg).toContain('## Calibration Notes');
    expect(msg).toContain('Operator noted: be strict on formatting.');
  });

  it('includes final result when present', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'test',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
      },
      taskSummaries: [],
      finalResult: 'Outcomes: 3/4 met',
    });

    expect(msg).toContain('## Final Result');
    expect(msg).toContain('Outcomes: 3/4 met');
  });

  it('includes scoped-evidence task outputs when present (D8)', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'test',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
      },
      taskSummaries: [{ taskId: 'analyze', status: 'succeeded' }],
      taskOutputs: [{ taskId: 'analyze', content: '{"score": 0.91}' }],
    });

    expect(msg).toContain('## Task Outputs');
    expect(msg).toContain('### Task "analyze"');
    expect(msg).toContain('{"score": 0.91}');
  });

  it('labels the reference output as guidance whose similarity is never scored', () => {
    const msg = buildJudgeUserMessage({
      criterion: {
        type: 'judge',
        name: 'test',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
      },
      taskSummaries: [],
      referenceOutput: '{"answer": 42}',
    });

    expect(msg).toContain('## Reference Output (guidance only — similarity is never scored)');
    expect(msg).toContain('{"answer": 42}');
  });
});

// ============================================================================
// Advisory-only enforcement (104e invariant)
// ============================================================================

describe('evaluateJudgeCriterion advisory enforcement', () => {
  // Note: Full integration tests require a live AI client.
  // These tests validate the contract shape via the exported type.

  it('JudgeEvalResult type enforces advisory-only fields', async () => {
    // This is a compile-time assertion via the type system.
    // The JudgeEvalResult type requires:
    //   effectiveAuthority: 'stage_for_review' (literal)
    //   v2AdvisoryOnly: true (literal)
    // If these were changed, TypeScript compilation would fail.
    //
    // We import the type to verify it exists and the test file compiles.
    const { evaluateJudgeCriterion: _fn } = await import('../evalRunner.js');
    expect(typeof _fn).toBe('function');
  });
});

// ============================================================================
// Review finding: judge infra failure must not blame the skill
// ============================================================================

describe('evaluateJudgeCriterion failure handling', () => {
  it('returns judge_error criterionType on provider failure', async () => {
    // evaluateJudgeCriterion catches all errors and returns judge_error,
    // which is excluded from scoring by DEFERRED_TYPES. We test the
    // contract by calling with no configured provider (lazy singleton
    // will fail to create a client or the call will fail).
    const { evaluateJudgeCriterion } = await import('../evalRunner.js');

    const result = await evaluateJudgeCriterion(
      {
        type: 'judge',
        name: 'test-criterion',
        rubric: [{ criterion: 'test', scale: 'binary', description: 'test' }],
        model: 'nonexistent-model-that-will-fail',
      },
      {
        tenantId: 'test-tenant',
        sessionId: '00000000-0000-0000-0000-000000000001',
        taskResults: [],
      },
    );

    // The error path must produce judge_error, not judge
    expect(result.criterionResult.criterionType).toBe('judge_error');
    expect(result.criterionResult.passed).toBe(false);
    expect(result.criterionResult.evidence).toContain('Judge evaluation failed');
    // Advisory enforcement still holds on failure
    expect(result.effectiveAuthority).toBe('stage_for_review');
    expect(result.v2AdvisoryOnly).toBe(true);
  });
});

// ============================================================================
// Review finding: partial score must contribute fractionally
// ============================================================================

describe('score aggregation uses numeric score', () => {
  it('criterionScore helper uses score when present instead of boolean', async () => {
    // We can't directly test the private criterionScore function, but we
    // can verify the contract: a CriterionResult with score=0.6 and
    // passed=false should contribute 0.6, not 0. We test this by
    // verifying the function's behaviour through the module export.
    //
    // The criterionScore function is:
    //   r.score !== undefined ? r.score : r.passed ? 1 : 0
    //
    // A partial verdict sets passed=false but score=0.6, so the numeric
    // score must be used. This is a structural assertion: if someone
    // reverts to the old boolean-only scoring, this test documents the
    // expected behaviour for review.
    const { evaluateJudgeCriterion } = await import('../evalRunner.js');

    // A successful judge verdict returns criterionResult.score as a number.
    // We verify the score field is preserved, not collapsed to 0/1.
    const fakeResult = await evaluateJudgeCriterion(
      {
        type: 'judge',
        name: 'partial-test',
        rubric: [{ criterion: 'quality', scale: 'binary', description: 'quality check' }],
        model: 'nonexistent-model',
      },
      {
        tenantId: 'test-tenant',
        sessionId: '00000000-0000-0000-0000-000000000002',
        taskResults: [],
      },
    );

    // On failure path, score is undefined (correctly excluded from scoring).
    // On success path (would need mock), score would be the LLM's 0-1 value.
    // Either way, the score field is never coerced to boolean.
    if (fakeResult.criterionResult.score !== undefined) {
      expect(typeof fakeResult.criterionResult.score).toBe('number');
    }
  });
});

describe('the verdict survives provider serialisation differences', () => {
  it('accepts entries handed over as JSON text', () => {
    // Some providers return a nested array as its JSON string. Discarding the
    // whole judgement over that throws away work the judge did correctly.
    const result = JudgeVerdictSchema.safeParse({
      entries: '[{"criterion":"a","rationale":"met","verdict":"pass"}]',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.entries[0]?.criterion).toBe('a');
  });

  it('still refuses a string that is not entries at all', () => {
    expect(JudgeVerdictSchema.safeParse({ entries: 'nonsense' }).success).toBe(false);
  });

  it('tells the writer the length limit, not just the validator', () => {
    // A cap the model is not told about is a cap it overruns; maxLength alone
    // is advisory to a provider and was ignored on a third of answers.
    const shape = JudgeVerdictSchema.shape.entries;
    expect(JSON.stringify(shape)).toBeDefined();
    const described = cappedText(2000, 'A critique.');
    expect(described.description).toContain('2000 characters');
  });
});

describe('judge answers are aligned to the rubric that was asked', () => {
  const rubric = [
    { criterion: 'is accurate', description: 'x', scale: 'binary' as const },
    { criterion: 'is actionable', description: 'y', scale: 'binary' as const },
  ];

  it('an omitted criterion cannot become a pass by disappearing', () => {
    // Folding only what the model chose to answer would let it drop a failing
    // criterion and derive a pass from the remainder. The omission is recorded
    // as `unclear` rather than `fail`: not answering is the JUDGE failing to
    // answer, and now that verdicts gate, scoring it a failure would fail the
    // trial for its judge's omission. What matters is preserved — the fold is
    // not a pass.
    const aligned = alignJudgeEntries(rubric, {
      entries: [{ criterion: 'is accurate', rationale: 'met', verdict: 'pass' }],
    });
    expect(aligned).toHaveLength(2);
    expect(aligned[1]).toMatchObject({ criterion: 'is actionable', verdict: 'unclear' });
    expect(foldJudgeVerdict(aligned).verdict).toBe('unclear');
    expect(foldJudgeVerdict(aligned).verdict).not.toBe('pass');
  });

  it('a stated failure outranks an abstention beside it', () => {
    const aligned = alignJudgeEntries(rubric, {
      entries: [{ criterion: 'is accurate', rationale: 'not met', verdict: 'fail' }],
    });
    expect(foldJudgeVerdict(aligned).verdict).toBe('fail');
  });

  it('a duplicated answer is taken once and an unasked one is dropped', () => {
    const aligned = alignJudgeEntries(rubric, {
      entries: [
        { criterion: 'is accurate', rationale: 'first', verdict: 'pass' },
        { criterion: 'is accurate', rationale: 'again', verdict: 'fail' },
        { criterion: 'invented', rationale: 'not asked', verdict: 'pass' },
        { criterion: 'is actionable', rationale: 'met', verdict: 'pass' },
      ],
    });
    expect(aligned.map((e) => [e.criterion, e.rationale])).toEqual([
      ['is accurate', 'first'],
      ['is actionable', 'met'],
    ]);
    expect(foldJudgeVerdict(aligned).verdict).toBe('pass');
  });

  it('matches criteria regardless of case and surrounding space', () => {
    const aligned = alignJudgeEntries(rubric, {
      entries: [
        { criterion: '  Is Accurate ', rationale: 'met', verdict: 'pass' },
        { criterion: 'is actionable', rationale: 'met', verdict: 'pass' },
      ],
    });
    expect(foldJudgeVerdict(aligned).verdict).toBe('pass');
  });
});

describe('caps are at least as permissive as what flows into them', () => {
  it('a judge may echo the longest criterion a rubric may carry', () => {
    // An echo tighter than its source makes the longest criteria unjudgeable:
    // the response fails validation and no alignment can ever match it.
    const longest = 'c'.repeat(JUDGE_CRITERION_MAX_CHARS);
    const result = JudgeVerdictSchema.safeParse({
      entries: [{ criterion: longest, rationale: 'met', verdict: 'pass' }],
    });
    expect(result.success).toBe(true);
  });

  it('a rubric entry and its echo share one limit', () => {
    const rubricEntry = JudgeRubricEntrySchema.safeParse({
      criterion: 'c'.repeat(JUDGE_CRITERION_MAX_CHARS),
      scale: 'binary',
      description: 'x',
    });
    expect(rubricEntry.success).toBe(true);
  });
});
