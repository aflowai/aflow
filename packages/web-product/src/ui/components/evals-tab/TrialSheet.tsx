'use client';

/**
 * TRIAL SHEET — one trial's attribution read beside the table it was picked
 * from, never inside it. Mounted here the panel cannot push the table's rows
 * around, so walking a batch's failures keeps every row where the eye left it.
 */
import { Sheet } from '@aflow/design-system';
import type { EvalBatchCaseResultView } from '@aflow/schemas';

import { TrialAttributionPanel } from './TrialAttributionPanel.js';

export function TrialSheet({
  spaceId,
  workflowSlug,
  batchId,
  row,
  caseResults,
  onSelectTrial,
  onClose,
}: {
  spaceId: string;
  workflowSlug: string;
  batchId: string;
  row: EvalBatchCaseResultView;
  caseResults: readonly EvalBatchCaseResultView[];
  onSelectTrial: (caseRevisionId: string, trial: number) => void;
  onClose: () => void;
}) {
  const title = `${row.caseTitle ?? row.caseRevisionId.slice(0, 8)} · trial ${String(row.trial)}`;
  return (
    <Sheet open title={title} onClose={onClose} placement="right" width={720} closeIcon="x">
      <TrialAttributionPanel
        key={`${row.caseRevisionId}:${String(row.trial)}`}
        spaceId={spaceId}
        workflowSlug={workflowSlug}
        batchId={batchId}
        caseRevisionId={row.caseRevisionId}
        trial={row.trial}
        row={row}
        caseResults={caseResults}
        onSelectTrial={onSelectTrial}
        onClose={onClose}
      />
    </Sheet>
  );
}
