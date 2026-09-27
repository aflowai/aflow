'use client';

/**
 * DATASET — the golden dataset as the operator's instrument: active cases
 * grouped by stratum, drafts awaiting ratification, coverage gaps derived
 * from the loaded set. Case writes are operator REST (D7); every write
 * carries the optimistic dataset-version precondition.
 */
import { useMemo, useState } from 'react';
import {
  Accordion,
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  EmptyState,
  Heading,
  Icon,
  JsonViewer,
  Pressable,
  Row,
  Text,
  type AccordionItemData,
} from '@aflow/design-system';
import type { GoldenCaseContent, GoldenCaseRevision } from '@aflow/schemas';

import { useApiMutation } from '../../hooks/useApiQuery.js';
import { CaseEditorDialog, type CaseEditorMode } from './CaseEditorDialog.js';
import type { GoldenDatasetResponse } from './evalsApi.js';
import { evalsKeys } from './evalsApi.js';
import type { CoverageView } from './evalsDerive.js';
import { deriveCaseReview, groupCasesByScenario } from './evalsDerive.js';
import { evidencePreStyle, INSPECTOR_MAX_HEIGHT_CSS } from './evalsStyles.js';

function toContent(revision: GoldenCaseRevision): GoldenCaseContent {
  const { caseId: _caseId, datasetId: _datasetId, ...content } = revision.case;
  return content;
}

/**
 * A case as the thing it describes: the request, the world it is asked in, and
 * what must then be true. The stored form is available underneath for anyone
 * checking a pattern or an id, but it is the wrong material for deciding
 * whether the case itself is right.
 */
function CaseReviewBody({ content }: { content: GoldenCaseContent }) {
  const [showRaw, setShowRaw] = useState(false);
  const review = useMemo(() => deriveCaseReview(content), [content]);

  return (
    <Column gap="sm" style={{ paddingBlock: 'var(--space-2)' }}>
      {review.request !== null && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            The customer writes
          </Text>
          <pre style={evidencePreStyle}>{review.request}</pre>
          {(review.personaId !== null || review.worldId !== null) && (
            <Text size="xs" color="muted">
              as {review.personaId ?? 'anybody'}
              {review.worldId !== null ? ` · ${review.worldId}` : ''}
            </Text>
          )}
        </Column>
      )}

      {review.requirements.length > 0 && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            The agent must
          </Text>
          {review.requirements.map((requirement, index) => (
            <Row key={`${requirement.text}|${String(index)}`} gap="xs" align="center" wrap>
              <Icon
                name={requirement.forbidden ? 'x' : 'check'}
                size="xs"
                style={{
                  color: requirement.forbidden
                    ? 'var(--color-danger-default)'
                    : 'var(--color-success-default)',
                }}
              />
              <Text size="xs">{requirement.text}</Text>
              <Badge variant="neutral">{requirement.instrument}</Badge>
              <Text size="xs" color="muted">
                {requirement.detail}
              </Text>
            </Row>
          ))}
        </Column>
      )}

      {review.judgeAsks.length > 0 && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            A judge also asks
          </Text>
          {review.judgeAsks.map((ask, index) => (
            <Row key={`${ask}|${String(index)}`} gap="xs" align="center" wrap>
              <Text size="xs">{ask}</Text>
              <Badge variant="neutral">judge</Badge>
            </Row>
          ))}
          <Text size="xs" color="muted">
            A judge reads the reply in whatever words it is written, so these hold across languages
            where a text match does not.
          </Text>
        </Column>
      )}

      {review.why !== null && (
        <Column gap="xs">
          <Text size="xs" weight="semibold" color="muted">
            Why this case exists
          </Text>
          <Text size="xs" color="muted">
            {review.why}
          </Text>
        </Column>
      )}

      <Row gap="xs">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setShowRaw(!showRaw);
          }}
        >
          {showRaw ? 'Hide the stored case' : 'Show the stored case'}
        </Button>
      </Row>
      {showRaw && (
        <JsonViewer
          data={content}
          collapsed={false}
          collapseDepth={2}
          maxHeight={INSPECTOR_MAX_HEIGHT_CSS}
          copyable
        />
      )}
    </Column>
  );
}

/** Only the non-default directions are shown, so each needs to read on its own. */
const DIRECTION_LABEL: Record<'should_pause' | 'should_block', string> = {
  should_pause: 'expects a pause',
  should_block: 'expects a refusal',
};

/**
 * The scenario names the case; the rest of the stratum is internal taxonomy
 * that reads as noise on every row. A chip is spent only where it marks
 * something to act on — a regression case must keep passing, and a case that
 * asserts a refusal is easy to misread as a broken one.
 */
function StratumChips({ revision }: { revision: GoldenCaseRevision }) {
  const { tier, direction, scenario } = revision.case.stratum;
  return (
    <Row gap="xs" align="center">
      <Text size="xs" color="muted">
        {scenario}
      </Text>
      {tier === 'regression' && <Badge variant="info">regression</Badge>}
      {direction !== 'should_succeed' && (
        <Badge variant="neutral">{DIRECTION_LABEL[direction]}</Badge>
      )}
    </Row>
  );
}

interface EditorState {
  mode: CaseEditorMode;
  caseId?: string | undefined;
  initialContent?: GoldenCaseContent | undefined;
}

export function DatasetSection({
  spaceId,
  workflowSlug,
  dataset,
  coverage,
}: {
  spaceId: string;
  workflowSlug: string;
  dataset: GoldenDatasetResponse;
  coverage: CoverageView;
}) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);

  const removeMutation = useApiMutation<{ caseId: string }>({
    path: ({ caseId }) =>
      `/spaces/${spaceId}/workflows/${workflowSlug}/golden-cases/${caseId}` +
      (dataset.dataset !== null
        ? `?expectedDatasetVersion=${String(dataset.dataset.datasetVersion)}`
        : ''),
    method: 'DELETE',
    spaceId,
    invalidate: [evalsKeys.dataset(spaceId, workflowSlug)],
  });

  const confirmRemove = (revision: GoldenCaseRevision, kind: 'case' | 'draft') => {
    const verb = kind === 'draft' ? 'Discard draft' : 'Remove case';
    if (!window.confirm(`${verb} "${revision.case.title}"? This bumps the dataset version.`)) {
      return;
    }
    removeMutation.mutate({ caseId: revision.caseId });
  };

  const groups = groupCasesByScenario(dataset.cases);
  const [openScenario, setOpenScenario] = useState<string | null>(groups[0]?.scenario ?? null);
  const isEmpty = dataset.cases.length === 0 && dataset.drafts.length === 0;

  const items: AccordionItemData[] = [];
  if (dataset.drafts.length > 0) {
    items.push({
      id: 'drafts',
      title: 'Drafts to ratify',
      subtitle: `${String(dataset.drafts.length)} awaiting ratification`,
      children: (
        <Column gap="xs">
          <Text size="xs" color="muted">
            Part of no dataset version until ratified.
          </Text>
          {dataset.drafts.map((draft) => (
            <Row
              key={draft.revisionId}
              gap="sm"
              align="center"
              wrap
              style={{
                padding: 'var(--space-2) var(--space-3)',
                border: '1px dashed var(--color-border-subtle)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <Badge variant="queued">draft</Badge>
              <Text size="sm">{draft.case.title}</Text>
              <StratumChips revision={draft} />
              {draft.case.provenance.runId !== undefined && (
                <Text size="xs" color="muted">
                  from run {draft.case.provenance.runId.slice(0, 8)}…
                </Text>
              )}
              <Row gap="xs" style={{ marginLeft: 'auto' }}>
                <Button
                  variant="primary"
                  size="sm"
                  iconOnly
                  aria-label="Review and accept this draft"
                  title="Review and accept"
                  onClick={() => {
                    setEditor({
                      mode: 'ratify',
                      caseId: draft.caseId,
                      initialContent: toContent(draft),
                    });
                  }}
                >
                  <Icon name="check" size="xs" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Discard this draft"
                  title="Discard"
                  onClick={() => {
                    confirmRemove(draft, 'draft');
                  }}
                >
                  <Icon name="x" size="xs" />
                </Button>
              </Row>
            </Row>
          ))}
        </Column>
      ),
    });
  }
  if (dataset.cases.length > 0) {
    items.push({
      id: 'cases',
      title: 'Active cases',
      subtitle: `${String(dataset.cases.length)} case${dataset.cases.length === 1 ? '' : 's'} · ${String(groups.length)} scenario${groups.length === 1 ? '' : 's'}`,
      children: (
        <Column gap="md">
          {groups.map((group) => {
            const groupOpen = openScenario === group.scenario;
            return (
              <Column key={group.scenario} gap="xs">
                <Pressable
                  onClick={() => {
                    setOpenScenario(groupOpen ? null : group.scenario);
                  }}
                  aria-expanded={groupOpen}
                  style={{ width: 'auto', gap: 'var(--space-1)' }}
                >
                  <Icon name={groupOpen ? 'caret-down' : 'caret-right'} size="xs" />
                  <Text size="xs" weight="semibold" color="muted">
                    {group.scenario}
                  </Text>
                  <Text size="xs" color="muted">
                    {group.cases.length}
                  </Text>
                </Pressable>
                {groupOpen && (
                  <>
                    {group.cases.map((revision) => {
                      const isOpen = openCaseId === revision.revisionId;
                      const contentId = `case-content-${revision.revisionId}`;
                      return (
                        <Column
                          key={revision.revisionId}
                          gap="xs"
                          style={{
                            padding: 'var(--space-2) var(--space-3)',
                            border: '1px solid var(--color-border-subtle)',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        >
                          <Row gap="sm" align="center" wrap>
                            <Pressable
                              onClick={() => {
                                setOpenCaseId(isOpen ? null : revision.revisionId);
                              }}
                              aria-expanded={isOpen}
                              aria-controls={contentId}
                              style={{ width: 'auto', gap: 'var(--space-1)' }}
                            >
                              <Icon name={isOpen ? 'caret-down' : 'caret-right'} size="xs" />
                              <Text size="sm">{revision.case.title}</Text>
                            </Pressable>
                            <StratumChips revision={revision} />
                            <Text size="xs" color="muted">
                              {revision.case.expectations.length} expectation
                              {revision.case.expectations.length === 1 ? '' : 's'}
                              {revision.case.rubrics.length > 0
                                ? ` · ${String(revision.case.rubrics.length)} rubric${revision.case.rubrics.length === 1 ? '' : 's'}`
                                : ''}
                            </Text>
                            <Row gap="xs" style={{ marginLeft: 'auto' }}>
                              <Button
                                variant="ghost"
                                size="sm"
                                iconOnly
                                aria-label={`Edit ${revision.case.title}`}
                                title="Edit"
                                onClick={() => {
                                  setEditor({
                                    mode: 'edit',
                                    caseId: revision.caseId,
                                    initialContent: toContent(revision),
                                  });
                                }}
                              >
                                <Icon name="pencil" size="xs" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                iconOnly
                                aria-label={`Remove ${revision.case.title}`}
                                title="Remove"
                                onClick={() => {
                                  confirmRemove(revision, 'case');
                                }}
                              >
                                <Icon name="trash" size="xs" />
                              </Button>
                            </Row>
                          </Row>
                          {isOpen && (
                            <div id={contentId}>
                              <CaseReviewBody content={toContent(revision)} />
                            </div>
                          )}
                        </Column>
                      );
                    })}
                  </>
                )}
              </Column>
            );
          })}
        </Column>
      ),
    });
  }

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center" wrap>
            <Heading level={5}>Golden dataset</Heading>
            {dataset.dataset !== null && (
              <Badge variant="neutral">v{dataset.dataset.datasetVersion}</Badge>
            )}
            <Text size="xs" color="muted">
              {dataset.cases.length} active case{dataset.cases.length === 1 ? '' : 's'}
              {dataset.drafts.length > 0
                ? ` · ${String(dataset.drafts.length)} draft${dataset.drafts.length === 1 ? '' : 's'} awaiting ratification`
                : ''}
            </Text>
            <div style={{ marginLeft: 'auto' }}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEditor({ mode: 'create' });
                }}
              >
                <Icon name="plus" size="xs" /> Add case
              </Button>
            </div>
          </Row>

          {isEmpty && (
            <EmptyState
              icon={<Icon name="skill" size="lg" />}
              title="No golden cases yet"
              description="The dataset grows from real runs: flag a run in chat (“promote this run to a golden case”) and ratify the draft here — or add a curated case directly. Every confirmed production failure that gets fixed should leave a regression case behind."
            />
          )}

          {items.length > 0 && (
            <Accordion multiple items={items} defaultExpanded={['drafts', 'cases']} />
          )}

          {(dataset.unreadable ?? []).length > 0 && (
            <Column gap="xs">
              <Text size="xs" weight="semibold" tone="danger">
                Cannot be read — these refuse a batch until they are repaired or removed
              </Text>
              {(dataset.unreadable ?? []).map((row) => (
                <Column key={row.revisionId} gap="xs">
                  <Row gap="xs" align="center" wrap>
                    <Icon name="warning-circle" size="xs" color="var(--color-danger-fg)" />
                    <Text size="xs" weight="semibold">
                      {row.title}
                    </Text>
                    <Text size="xs" color="muted" variant="mono">
                      {row.caseId.slice(0, 8)}…
                    </Text>
                  </Row>
                  <Text size="xs" color="muted">
                    {row.reason}
                  </Text>
                </Column>
              ))}
            </Column>
          )}

          {(coverage.gaps.length > 0 || coverage.singletonScenarios > 0) && (
            <Column gap="xs">
              {coverage.gaps.length > 0 && (
                <>
                  <Text size="xs" weight="semibold" color="muted">
                    Coverage gaps — strata with zero cases
                  </Text>
                  <Row gap="xs" wrap>
                    {coverage.gaps.map((gap) => (
                      <Badge key={`${gap.scenario}|${gap.tier}|${gap.direction}`} variant="warning">
                        {gap.scenario} · {gap.tier} · {gap.direction.replace('should_', 'should ')}
                      </Badge>
                    ))}
                  </Row>
                </>
              )}
              {coverage.singletonScenarios > 0 && (
                <Text size="xs" color="muted">
                  {coverage.singletonScenarios === 1
                    ? 'One scenario carries a single case, so its coverage cannot be assessed.'
                    : `${String(coverage.singletonScenarios)} scenarios carry a single case each, so their coverage cannot be assessed — a scenario groups cases only once more than one shares it.`}
                </Text>
              )}
            </Column>
          )}
        </Column>
      </CardBody>
      {editor !== null && (
        <CaseEditorDialog
          open
          onClose={() => {
            setEditor(null);
          }}
          spaceId={spaceId}
          workflowSlug={workflowSlug}
          mode={editor.mode}
          {...(editor.caseId !== undefined ? { caseId: editor.caseId } : {})}
          {...(editor.initialContent !== undefined
            ? { initialContent: editor.initialContent }
            : {})}
          {...(dataset.dataset !== null
            ? { expectedDatasetVersion: dataset.dataset.datasetVersion }
            : {})}
        />
      )}
    </Card>
  );
}
