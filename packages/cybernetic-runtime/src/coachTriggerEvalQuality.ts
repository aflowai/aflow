import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { CyberneticEvalSuite, EntityDirectives, EvalQualityReport } from '@aflow/schemas';
import {
  computeEvalQualityReport,
  formatCampaignParamForDisplay,
  formatThresholdOperatorForDisplay,
} from '@aflow/schemas';
import { loadRecentResults } from './baselineManager.js';

export async function loadEvalQualityReportForReview(params: {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  workflowSlug: string;
  evalSuite: CyberneticEvalSuite | null;
  isValidityRepair: boolean;
  directives: EntityDirectives | undefined;
}): Promise<EvalQualityReport | null> {
  if (!params.evalSuite || params.isValidityRepair) return null;
  try {
    const minSamples =
      params.directives?.learningPolicy.evalQualityReport.alwaysPassesMinSamples ?? 10;
    const recentEvalResults = await loadRecentResults(
      params.db,
      params.tenantId,
      params.spaceId,
      params.workflowSlug,
      minSamples,
    );
    return computeEvalQualityReport(params.evalSuite, recentEvalResults, { minSamples });
  } catch {
    return null;
  }
}

export function formatEvalSuiteForPrompt(
  suite: CyberneticEvalSuite | null,
  qualityReport?: EvalQualityReport | null,
): string {
  if (!suite) return '';
  interface Row {
    tier: string;
    criterion: CyberneticEvalSuite['goalCriteria'][number];
  }
  const rows: Row[] = [
    ...suite.goalCriteria.map((c) => ({ tier: 'goal', criterion: c })),
    ...Object.entries(suite.taskCriteria).flatMap(([taskId, arr]) =>
      arr.map((c) => ({ tier: `task:${taskId}`, criterion: c })),
    ),
    ...suite.trajectoryCriteria.map((c) => ({ tier: 'trajectory', criterion: c })),
  ];
  if (rows.length === 0) return '';
  const alwaysPasses = new Set(
    (qualityReport?.criteria ?? []).filter((c) => c.alwaysPasses).map((c) => `${c.tier} ${c.name}`),
  );
  const lines = rows.map(({ tier, criterion: c }) => {
    let detail = '';
    switch (c.type) {
      case 'threshold':
        detail = `${c.metric} ${formatThresholdOperatorForDisplay(c.operator)} ${formatCampaignParamForDisplay(c.target)}${
          c.targetHigh !== undefined ? '…' + String(c.targetHigh) : ''
        }`;
        break;
      case 'contains':
        detail = c.inField
          ? `inField="${c.inField}" pattern="${c.pattern}"`
          : `pattern="${c.pattern}" (no inField — criterion will not resolve)`;
        break;
      case 'judge':
        detail = `${String(c.rubric.length)} rubric entries`;
        break;
      case 'trace_bound':
        detail = 'trace constraint';
        break;
    }
    const flag = alwaysPasses.has(`${tier} ${c.name}`)
      ? ` ⚠ always-passes (non-informative over the last ${String(qualityReport?.minSamples ?? 0)}+ samples — it no longer discriminates; consider proposing a tighter criterion)`
      : '';
    return `- ${tier} · ${c.name} · ${c.type} · ${detail}${flag}`;
  });
  return ['Active eval suite (these criteria graded this run):', ...lines].join('\n');
}
