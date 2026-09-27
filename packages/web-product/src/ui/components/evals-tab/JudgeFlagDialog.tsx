'use client';

/**
 * FLAG — the operator's disagreement with one judge verdict, recorded where
 * the verdict is read rather than in a separate bench.
 *
 * The label it writes is the operator's own verdict, so the flag states the
 * opposite of what the judge returned and asks only for the reason. It is
 * enriched material by construction — an operator flags what looked wrong, so
 * the sample is self-selected and can never enter a scorecard. The server
 * stamps `partition: 'exemplar'` for exactly that reason; nothing here may
 * declare one.
 */
import { useState } from 'react';
import { Button, Column, Dialog, Row, Text, Textarea, useToast } from '@aflow/design-system';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import type { ApiError } from '../../lib/query-client.js';

import { evalsKeys } from './evalsApi.js';

/** Exactly the case-scoped label subject the eval-labels route accepts. */
interface EvalLabelBody {
  runId: string;
  batchId: string;
  caseRevisionId: string;
  trial: number;
  criterionId: string;
  scopeKey: string;
  verdict: 'pass' | 'fail';
  critique: string;
  judgeVersion: string;
}

/** The judged rubric slot under dispute. */
export interface JudgeFlagSubject {
  criterionId: string;
  scopeKey: string;
  verdict: 'pass' | 'fail' | 'unclear';
  judgeVersion: string;
  rationale: string;
}

export function JudgeFlagDialog({
  spaceId,
  workflowSlug,
  batchId,
  caseRevisionId,
  trial,
  runId,
  subject,
  onClose,
}: {
  spaceId: string;
  workflowSlug: string;
  batchId: string;
  caseRevisionId: string;
  trial: number;
  runId: string;
  subject: JudgeFlagSubject;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [critique, setCritique] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  // An abstention has no opposite to assume, so the operator states the
  // verdict outright; a plain pass/fail is disputed by flipping it.
  const [chosen, setChosen] = useState<'pass' | 'fail' | null>(
    subject.verdict === 'pass' ? 'fail' : subject.verdict === 'fail' ? 'pass' : null,
  );

  const flag = useApiMutation<EvalLabelBody>({
    path: `/spaces/${spaceId}/workflows/${workflowSlug}/eval-labels`,
    method: 'POST',
    spaceId,
    invalidate: [evalsKeys.trial(spaceId, batchId, caseRevisionId, trial)],
    onSuccess: () => {
      toast({
        title: 'Your verdict is recorded',
        description: `It stands against ${subject.criterionId} as the human answer for this trial.`,
        tone: 'success',
      });
      onClose();
    },
    onError: (error: ApiError) => {
      setFailure(
        error.status === 409
          ? 'You have already recorded a verdict for this criterion on this trial.'
          : 'The flag was not recorded. Nothing was saved.',
      );
    },
  });

  const ready = chosen !== null && critique.trim().length > 0 && !flag.isPending;

  return (
    <Dialog
      open
      onClose={onClose}
      title="The judge got this wrong"
      width="sm"
      footer={
        <Row gap="sm" justify="end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!ready}
            onClick={() => {
              if (chosen === null) return;
              flag.mutate({
                runId,
                batchId,
                caseRevisionId,
                trial,
                criterionId: subject.criterionId,
                scopeKey: subject.scopeKey,
                verdict: chosen,
                critique: critique.trim(),
                judgeVersion: subject.judgeVersion,
              });
            }}
          >
            {flag.isPending ? 'Recording…' : 'Record my verdict'}
          </Button>
        </Row>
      }
    >
      <Column gap="sm">
        <Text size="sm" color="secondary">
          The judge returned <strong>{subject.verdict}</strong> on{' '}
          <Text as="span" variant="mono" size="sm">
            {subject.criterionId} · {subject.scopeKey}
          </Text>
          . Recording this files your verdict as the human answer for this trial.
        </Text>

        <Column gap="xs">
          <Text size="xs" color="muted">
            What this trial should have been
          </Text>
          <Row gap="sm">
            {(['pass', 'fail'] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={chosen === option ? 'primary' : 'secondary'}
                disabled={flag.isPending}
                onClick={() => {
                  setChosen(option);
                }}
              >
                {option === 'pass' ? 'It should have passed' : 'It should have failed'}
              </Button>
            ))}
          </Row>
        </Column>

        {subject.rationale !== '' && (
          <Column gap="xs">
            <Text size="xs" color="muted">
              What the judge said
            </Text>
            <Text size="xs" color="secondary">
              {subject.rationale}
            </Text>
          </Column>
        )}

        <Column gap="xs">
          <Text size="xs" color="muted">
            Why it is wrong
          </Text>
          <Textarea
            value={critique}
            onChange={(event) => {
              setCritique(event.target.value);
            }}
            placeholder="What the judge missed, or what the rubric actually asks for"
            rows={4}
            autoFocus
            disabled={flag.isPending}
            aria-label="Why the judge is wrong"
            style={{ width: '100%', resize: 'vertical' }}
          />
          <Text size="xs" color="muted">
            This is the material a rubric repair is argued from, so say what the criterion should
            have asked.
          </Text>
        </Column>

        {failure !== null && (
          <Text size="xs" tone="danger">
            {failure}
          </Text>
        )}
      </Column>
    </Dialog>
  );
}
