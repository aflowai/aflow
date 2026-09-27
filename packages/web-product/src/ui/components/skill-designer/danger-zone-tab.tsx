'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Input,
  Row,
  Text,
} from '@aflow/design-system';

interface PreviewResponse {
  skillId: string;
  kind: 'archive' | 'purge';
  isPlatformSkill: boolean;
  affectedDocPaths: string[];
  proposalsToClose: number;
  feedbackRowsToDelete: number;
  causalMeasurementsToDelete: number;
  historicalRunCount: number;
  activeRunCount: number;
}

interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface DangerZoneTabProps {
  apiUrl: string;
  headers: () => Record<string, string>;
  spaceId: string;
  skillId: string;
  /** Display name (used in the type-to-confirm gate for purge). */
  skillName: string;
  /** Set when the loaded skill is currently archived. Drives Unarchive UI. */
  archivedAt: string | null;
  /** True for platform skills — those are immutable through this surface. */
  isPlatformSkill: boolean;
  /** Called after a successful archive/unarchive/purge so the parent can
   *  reload the page or navigate away. */
  onActionCompleted: () => void;
}

export function DangerZoneTab({
  apiUrl,
  headers,
  spaceId,
  skillId,
  skillName,
  archivedAt,
  isPlatformSkill,
  onActionCompleted,
}: DangerZoneTabProps): ReactElement {
  const [archivePreview, setArchivePreview] = useState<PreviewResponse | null>(null);
  const [purgePreview, setPurgePreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [actionInflight, setActionInflight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purgeShown, setPurgeShown] = useState(false);
  const [forceArchive, setForceArchive] = useState(false);

  const fetchPreviews = useCallback(async () => {
    if (isPlatformSkill) return;
    setPreviewError(null);
    try {
      const baseUrl = `${apiUrl}/spaces/${spaceId}/skills/${encodeURIComponent(skillId)}/preview`;
      const hdrs = { ...headers(), 'X-Space-ID': spaceId };
      const [arRes, pgRes] = await Promise.all([
        fetch(`${baseUrl}?kind=archive`, { headers: hdrs }),
        fetch(`${baseUrl}?kind=purge`, { headers: hdrs }),
      ]);
      if (arRes.ok) setArchivePreview((await arRes.json()) as PreviewResponse);
      if (pgRes.ok) setPurgePreview((await pgRes.json()) as PreviewResponse);
      if (!arRes.ok && !pgRes.ok) {
        setPreviewError(`Unable to load preview counts (HTTP ${String(arRes.status)})`);
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
    }
  }, [apiUrl, headers, isPlatformSkill, skillId, spaceId]);

  useEffect(() => {
    void fetchPreviews();
  }, [fetchPreviews]);

  const callAction = useCallback(
    async (
      action: 'archive' | 'unarchive' | 'purge',
      body?: Record<string, unknown>,
    ): Promise<void> => {
      setActionInflight(action);
      setActionError(null);
      try {
        const url = `${apiUrl}/spaces/${spaceId}/skills/${encodeURIComponent(skillId)}/${action}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...headers(), 'X-Space-ID': spaceId, 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as Partial<ErrorResponse>;
          throw new Error(errBody.message ?? `HTTP ${String(res.status)}`);
        }
        onActionCompleted();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : `Failed to ${action} skill`);
      } finally {
        setActionInflight(null);
      }
    },
    [apiUrl, headers, onActionCompleted, skillId, spaceId],
  );

  if (isPlatformSkill) {
    return (
      <Column gap="md" padding="lg">
        <Card>
          <CardBody>
            <Text>
              <strong>This is a platform-owned skill</strong> — it cannot be archived or deleted
              from this surface. Platform skills live in code and are managed through deployment.
            </Text>
          </CardBody>
        </Card>
      </Column>
    );
  }

  const isArchived = archivedAt !== null;
  const activeRunBlock =
    (archivePreview?.activeRunCount ?? 0) > 0 ? archivePreview!.activeRunCount : 0;

  return (
    <Column gap="md" padding="lg">
      {previewError && (
        <Card>
          <CardBody>
            <Text style={{ color: 'var(--color-status-warning)' }}>{previewError}</Text>
          </CardBody>
        </Card>
      )}

      {actionError && (
        <Card>
          <CardBody>
            <Text style={{ color: 'var(--color-status-danger)' }}>{actionError}</Text>
          </CardBody>
        </Card>
      )}

      {/* Archive / Unarchive panel */}
      <Card style={{ borderColor: 'var(--color-border-warning, var(--color-border))' }}>
        <CardBody>
          <Column gap="sm">
            <Row gap="sm" align="center">
              <Text size="lg">
                <strong>{isArchived ? 'Restore this skill' : 'Archive this skill'}</strong>
              </Text>
              {isArchived && <Badge variant="warning">Archived</Badge>}
            </Row>

            {isArchived ? (
              <>
                <Text>
                  This skill was archived on{' '}
                  <strong>{archivedAt ? new Date(archivedAt).toLocaleString() : '—'}</strong>.
                  Restoring re-enables the manifest, projection, workflow, and the staged proposals
                  that archive soft-closed.
                </Text>
                <Text size="sm">
                  Telemetry (feedback, causal measurements) was never touched by archive — those
                  rows are still present and will be visible immediately after restore.
                </Text>
                <Row gap="sm">
                  <Button
                    variant="primary"
                    disabled={actionInflight !== null}
                    onClick={() => void callAction('unarchive')}
                  >
                    {actionInflight === 'unarchive' ? 'Restoring…' : 'Unarchive skill'}
                  </Button>
                </Row>
              </>
            ) : (
              <>
                <Text>
                  Hides the skill from the agent. Run history, feedback, and causal measurements are
                  all preserved. <strong>Fully reversible</strong> via Unarchive.
                </Text>
                {archivePreview && (
                  <Text size="sm">
                    On confirm: {archivePreview.affectedDocPaths.length} document(s) will be
                    soft-deleted
                    {archivePreview.proposalsToClose > 0
                      ? `; ${String(archivePreview.proposalsToClose)} pending Coach proposal(s) will be soft-closed`
                      : ''}
                    .
                  </Text>
                )}
                {activeRunBlock > 0 && (
                  <Text size="sm" style={{ color: 'var(--color-status-warning)' }}>
                    {String(activeRunBlock)} active workflow run(s).
                  </Text>
                )}
                {activeRunBlock > 0 && (
                  <Checkbox
                    size="sm"
                    checked={forceArchive}
                    onChange={(e) => {
                      setForceArchive(e.target.checked);
                    }}
                    label="Force-cancel active runs that are stalled"
                  />
                )}
                <Row gap="sm">
                  <Button
                    variant="secondary"
                    disabled={actionInflight !== null || (activeRunBlock > 0 && !forceArchive)}
                    onClick={() =>
                      void callAction('archive', forceArchive ? { force: true } : undefined)
                    }
                  >
                    {actionInflight === 'archive' ? 'Archiving…' : 'Archive skill'}
                  </Button>
                </Row>
              </>
            )}
          </Column>
        </CardBody>
      </Card>

      {/* Permanent delete (purge) panel — only meaningful for archived skills */}
      <Card style={{ borderColor: 'var(--color-border-danger, var(--color-border))' }}>
        <CardBody>
          <Column gap="sm">
            <Row gap="sm" align="center">
              <Text size="lg">
                <strong>Permanently delete</strong>
              </Text>
              <Badge variant="danger">Irreversible</Badge>
            </Row>
            <Text>
              Removes the skill's manifest, workflow, evals, AND all feedback and causal-measurement
              rows for this skill. A tombstone is kept so historical runs still show "deleted on …".{' '}
              <strong>Available only for archived skills. Cannot be undone.</strong>
            </Text>

            {!isArchived && (
              <Text size="sm" style={{ color: 'var(--color-text-secondary)' }}>
                Archive the skill first to enable permanent deletion.
              </Text>
            )}

            {isArchived && purgePreview && (
              <Text size="sm">
                On confirm: {purgePreview.feedbackRowsToDelete} feedback row(s),{' '}
                {purgePreview.causalMeasurementsToDelete} causal-measurement row(s), and{' '}
                {purgePreview.affectedDocPaths.length} document(s) will be permanently deleted.
                {purgePreview.historicalRunCount > 0 && (
                  <>
                    {' '}
                    {String(purgePreview.historicalRunCount)} historical run(s) will dangle (point
                    at a deleted skill via tombstone).
                  </>
                )}
              </Text>
            )}

            {isArchived && !purgeShown && (
              <Row gap="sm">
                <Button
                  variant="ghost"
                  disabled={actionInflight !== null}
                  onClick={() => {
                    setPurgeShown(true);
                  }}
                >
                  Show permanent delete confirmation
                </Button>
              </Row>
            )}

            {isArchived && purgeShown && (
              <Column gap="sm">
                <Text size="sm">
                  Type the skill's name <strong>{skillName}</strong> exactly to enable the delete
                  button:
                </Text>
                <Input
                  value={purgeConfirmText}
                  onChange={(e) => {
                    setPurgeConfirmText(e.target.value);
                  }}
                  placeholder={skillName}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
                <Row gap="sm">
                  <Button
                    variant="ghost"
                    disabled={actionInflight !== null}
                    onClick={() => {
                      setPurgeShown(false);
                      setPurgeConfirmText('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    disabled={
                      actionInflight !== null ||
                      purgeConfirmText !== skillName ||
                      // If active runs exist, purge will reject too — show as disabled.
                      (purgePreview?.activeRunCount ?? 0) > 0
                    }
                    onClick={() =>
                      void callAction('purge', {
                        confirmRunHistoryDangling: (purgePreview?.historicalRunCount ?? 0) > 0,
                      })
                    }
                  >
                    {actionInflight === 'purge' ? 'Deleting…' : 'Permanently delete this skill'}
                  </Button>
                </Row>
              </Column>
            )}
          </Column>
        </CardBody>
      </Card>
    </Column>
  );
}
