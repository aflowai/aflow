import { describe, it, expect } from 'vitest';
import type { ActiveLearning } from '@aflow/schemas';
import { renderLearningSetBlock } from '../learningRender.js';

describe('renderLearningSetBlock', () => {
  it('renders trajectory first, then one line per learning, with detail refs', () => {
    const selected: ActiveLearning[] = [
      {
        kind: 'trajectory',
        objective: { metricKey: 'rmsle', direction: 'minimize' },
        peak: 0.128,
        recentScores: [0.131, 0.128],
      },
      {
        kind: 'durable',
        learningId: '00000000-0000-0000-0000-000000000001',
        statement: 'log-transform the target',
        learningKind: 'heuristic',
        confidence: 'high',
        scopeKind: 'campaign',
      },
      {
        kind: 'candidate',
        runId: 'run-1',
        learningId: 'l-1',
        category: 'worked',
        observation: 'ensembling helped',
        recommendation: 'keep the blend',
        confidence: 'medium',
        detailRef: '/coach/learnings/detail/l-1.md',
      },
    ];

    expect(renderLearningSetBlock(selected)).toBe(
      [
        '- [trajectory] objective: minimize rmsle; peak so far: 0.128; recent scores: 0.131, 0.128',
        '- [heuristic] log-transform the target',
        '- [worked] ensembling helped → keep the blend (detail: /coach/learnings/detail/l-1.md)',
      ].join('\n'),
    );
  });

  it('renders the empty set to an empty string', () => {
    expect(renderLearningSetBlock([])).toBe('');
  });
});
