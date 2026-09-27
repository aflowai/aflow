import type { ActiveLearning } from '@aflow/schemas';

export interface InjectedLearning {
  category: string;
  observation: string;
  recommendation?: string;
  detailRef?: string;
}

export function renderActiveLearningEntry(entry: ActiveLearning): InjectedLearning {
  switch (entry.kind) {
    case 'trajectory': {
      const parts = [
        `objective: ${entry.objective.direction} ${entry.objective.metricKey}`,
        entry.peak !== undefined
          ? `peak so far: ${entry.peak}`
          : 'peak so far: (no scored runs yet)',
        entry.recentScores.length > 0
          ? `recent scores: ${entry.recentScores.join(', ')}`
          : 'recent scores: (none)',
      ];
      return { category: 'trajectory', observation: parts.join('; ') };
    }
    case 'durable':
      return {
        category: entry.learningKind,
        observation: entry.statement,
        ...(entry.detailRef ? { detailRef: entry.detailRef } : {}),
      };
    case 'candidate':
      return {
        category: entry.category,
        observation: entry.observation,
        ...(entry.recommendation ? { recommendation: entry.recommendation } : {}),
        ...(entry.detailRef ? { detailRef: entry.detailRef } : {}),
      };
  }
}

/**
 * Format learnings into a readable text block ('' when none):
 * one `- [category] observation → recommendation (detail: ref)` line each.
 */
export function formatLearningLines(learnings: InjectedLearning[]): string {
  if (learnings.length === 0) return '';

  const lines: string[] = [];

  for (const learning of learnings) {
    let line = `[${learning.category}] ${learning.observation}`;
    if (learning.recommendation) {
      line += ` → ${learning.recommendation}`;
    }
    if (learning.detailRef) {
      line += ` (detail: ${learning.detailRef})`;
    }
    lines.push(`- ${line}`);
  }

  return lines.join('\n');
}

/** Render a selector output straight to the injectable text block. */
export function renderLearningSetBlock(selected: ActiveLearning[]): string {
  return formatLearningLines(selected.map(renderActiveLearningEntry));
}
