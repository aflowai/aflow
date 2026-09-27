/**
 * D9 judge identity: judgeVersion = hash(rubric entries, judge model id,
 * prompt template version), computed at read. Stability under identical
 * inputs and change detection under any edited input are the whole contract.
 */
import { describe, expect, it } from 'vitest';
import type { JudgeRubricEntry } from '@aflow/schemas';
import { computeJudgeVersion } from '../judgeVersion.js';
import { JUDGE_PROMPT_TEMPLATE_VERSION } from '../prompts/judge.js';

const RUBRIC: JudgeRubricEntry[] = [
  { criterion: 'Correct answer', scale: 'binary', description: 'Must match expected' },
  { criterion: 'Clear explanation', scale: 'binary', description: 'Clarity of reasoning' },
];

describe('computeJudgeVersion', () => {
  it('is stable: identical inputs always hash identically', () => {
    expect(computeJudgeVersion(RUBRIC, 'judge-model-a')).toBe(
      computeJudgeVersion(RUBRIC, 'judge-model-a'),
    );
  });

  it('is key-order independent (stableHash canonicalization)', () => {
    const reordered = RUBRIC.map((e) => ({
      description: e.description,
      scale: e.scale,
      criterion: e.criterion,
    })) as JudgeRubricEntry[];
    expect(computeJudgeVersion(reordered, 'judge-model-a')).toBe(
      computeJudgeVersion(RUBRIC, 'judge-model-a'),
    );
  });

  it('a rubric edit yields a new version', () => {
    const edited: JudgeRubricEntry[] = [
      { ...RUBRIC[0]!, description: 'Must match expected exactly' },
      RUBRIC[1]!,
    ];
    expect(computeJudgeVersion(edited, 'judge-model-a')).not.toBe(
      computeJudgeVersion(RUBRIC, 'judge-model-a'),
    );
  });

  it('a judge model change yields a new version', () => {
    expect(computeJudgeVersion(RUBRIC, 'judge-model-b')).not.toBe(
      computeJudgeVersion(RUBRIC, 'judge-model-a'),
    );
  });

  it('a prompt template version bump yields a new version', () => {
    expect(
      computeJudgeVersion(RUBRIC, 'judge-model-a', `${JUDGE_PROMPT_TEMPLATE_VERSION}-next`),
    ).not.toBe(computeJudgeVersion(RUBRIC, 'judge-model-a'));
  });

  it('defaults the template version to the current prompt template', () => {
    expect(computeJudgeVersion(RUBRIC, 'judge-model-a', JUDGE_PROMPT_TEMPLATE_VERSION)).toBe(
      computeJudgeVersion(RUBRIC, 'judge-model-a'),
    );
  });
});

describe('the evidence pack is part of judge identity', () => {
  it('a different evidence version is a different judge', () => {
    // Changing what the judge is shown moves its verdicts. If the version did
    // not move with it, a calibration measured on the old pack would keep an
    // authority it no longer has, and the shift would read as the subject
    // drifting rather than the ruler.
    const rubric = [{ criterion: 'clarity', description: 'is it clear', scale: 'binary' as const }];
    const before = computeJudgeVersion(rubric, 'gpt-5.6-luna', 'critique-then-verdict-1', 'pack-1');
    const after = computeJudgeVersion(rubric, 'gpt-5.6-luna', 'critique-then-verdict-1', 'pack-2');
    expect(before).not.toBe(after);
  });
});
