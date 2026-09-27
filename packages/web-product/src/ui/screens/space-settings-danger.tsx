'use client';

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Input,
  PageContainer,
  Row,
  Text,
} from '@aflow/design-system';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useSpace } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { useNavigation } from '../components/navigation-provider.js';

interface PreviewResponse {
  spaceId: string;
  isGeneralSpace: boolean;
  isTenantDefaultSpace: boolean;
  activeSessionCount: number;
  activeWorkflowRunCount: number;
  activeScheduleCount: number;
  activeWebhookCount: number;
  memberCount: number;
  blockingItems: Array<{ kind: 'session' | 'workflow_run'; id: string; status: string }>;
}

interface ErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function DangerZonePage(): ReactElement {
  const { apiUrl, headers } = useApi();
  const { activeSpace, activeSpaceId, accessibleSpaces, setActiveSpaceId, refresh } = useSpace();
  const queryClient = useQueryClient();
  const { push } = useNavigation();

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [actionInflight, setActionInflight] = useState<'archive' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [reason, setReason] = useState('');
  const [forceArchive, setForceArchive] = useState(false);

  const fetchPreview = useCallback(async () => {
    if (!activeSpaceId) return;
    setPreviewError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/archive-preview`, {
        headers: { ...headers(), 'X-Space-ID': activeSpaceId },
      });
      if (!res.ok) {
        setPreviewError(`Unable to load preview (HTTP ${String(res.status)})`);
        return;
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
    }
  }, [apiUrl, headers, activeSpaceId]);

  useEffect(() => {
    void fetchPreview();
  }, [fetchPreview]);

  const handleArchive = useCallback(async () => {
    if (!activeSpaceId) return;
    setActionInflight('archive');
    setActionError(null);
    try {
      const res = await fetch(`${apiUrl}/spaces/${activeSpaceId}/archive`, {
        method: 'POST',
        headers: {
          ...headers(),
          'X-Space-ID': activeSpaceId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...(reason ? { reason } : {}),
          ...(forceArchive ? { force: true } : {}),
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Partial<ErrorResponse>;
        throw new Error(errBody.message ?? `HTTP ${String(res.status)}`);
      }
      // Success — switch to a non-archived space BEFORE navigating, otherwise
      // the central preHandler will 410 every request that still references
      // the archived space via localStorage. The space list (active-only)
      // is the source of truth for what's available.
      const fallback = accessibleSpaces.find((s) => s.id !== activeSpaceId);
      if (fallback) {
        setActiveSpaceId(fallback.id);
      }
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['spaces'] });
      void queryClient.invalidateQueries({ queryKey: ['space', activeSpaceId] });
      // `/chat` is the dashboard home; it works for any active space and
      // gracefully renders an empty state if none is selected (the user has
      // no other accessible spaces — e.g. a personal-space owner who just
      // archived their only personal workspace).
      push(spaceRoute(fallback?.slug ?? activeSpace?.slug, '/chat'));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to archive space');
    } finally {
      setActionInflight(null);
    }
  }, [
    apiUrl,
    headers,
    activeSpaceId,
    accessibleSpaces,
    setActiveSpaceId,
    reason,
    forceArchive,
    refresh,
    push,
  ]);

  const expectedConfirm = activeSpace?.name ?? '';
  const canConfirm = confirmText === expectedConfirm && expectedConfirm.length > 0;

  const hasActiveWork =
    !!preview && (preview.activeSessionCount > 0 || preview.activeWorkflowRunCount > 0);

  // Hard blocks — can't be bypassed by force.
  const hardBlockReason = useMemo(() => {
    if (!preview) return null;
    if (preview.isGeneralSpace) {
      return 'This is the tenant General space — it cannot be archived.';
    }
    return null;
  }, [preview]);

  // Active work blocks unless force is checked.
  const blockingReason = useMemo(() => {
    if (hardBlockReason) return hardBlockReason;
    if (!preview) return null;
    if (hasActiveWork && !forceArchive) {
      const parts: string[] = [];
      if (preview.activeSessionCount > 0)
        parts.push(`${String(preview.activeSessionCount)} active session(s)`);
      if (preview.activeWorkflowRunCount > 0)
        parts.push(`${String(preview.activeWorkflowRunCount)} active workflow run(s)`);
      return `${parts.join(' and ')} — tick the force option below to cancel them and archive.`;
    }
    return null;
  }, [hardBlockReason, preview, hasActiveWork, forceArchive]);

  if (!activeSpace) {
    return (
      <PageContainer maxWidth={720}>
        <Text>Select a space first.</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer maxWidth={720}>
      <Column gap="md">
        <Card style={{ borderColor: 'var(--color-border-warning, var(--color-border))' }}>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Text size="lg">
                  <strong>Archive this space</strong>
                </Text>
                {preview?.isTenantDefaultSpace && <Badge variant="warning">Tenant default</Badge>}
                {preview?.isGeneralSpace && <Badge variant="danger">General space</Badge>}
              </Row>

              <Text>
                Hides the space from members. Schedules and webhooks are paused. Run history,
                memberships, feedback, and causal-measurement rows are preserved.{' '}
                <strong>Reversible</strong> from the Archived spaces list.
              </Text>

              {previewError && (
                <Text size="sm" style={{ color: 'var(--color-status-warning)' }}>
                  {previewError}
                </Text>
              )}

              {preview && (
                <Column gap="xs">
                  <Text size="sm">
                    On confirm:{' '}
                    {preview.activeScheduleCount > 0 && (
                      <>{String(preview.activeScheduleCount)} schedule(s) will be paused; </>
                    )}
                    {preview.activeWebhookCount > 0 && (
                      <>{String(preview.activeWebhookCount)} webhook(s) will be paused; </>
                    )}
                    {preview.memberCount} member(s) preserved.
                  </Text>
                  {preview.isTenantDefaultSpace && (
                    <Text size="sm">
                      The tenant default will be reassigned to the General space.
                    </Text>
                  )}
                  <Text size="sm" style={{ color: 'var(--color-text-secondary)' }}>
                    Schedules and webhooks paused by archive will <em>not</em> auto-re-enable on
                    Unarchive — operator opts back in deliberately.
                  </Text>
                </Column>
              )}

              {blockingReason && (
                <Text size="sm" style={{ color: 'var(--color-status-warning)' }}>
                  {blockingReason}
                </Text>
              )}

              {hasActiveWork && !hardBlockReason && (
                <Checkbox
                  size="sm"
                  checked={forceArchive}
                  onChange={(e) => {
                    setForceArchive(e.target.checked);
                  }}
                  label="Force-cancel pending sessions and runs (skips any actively executing)"
                />
              )}

              {actionError && (
                <Text size="sm" style={{ color: 'var(--color-status-danger)' }}>
                  {actionError}
                </Text>
              )}

              <Column gap="xs">
                <Text size="sm">
                  Type the space name <strong>{expectedConfirm}</strong> to enable archive:
                </Text>
                <Input
                  value={confirmText}
                  onChange={(e) => {
                    setConfirmText(e.target.value);
                  }}
                  placeholder={expectedConfirm}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
                <Input
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                  placeholder="Optional reason for the audit log"
                />
              </Column>

              <Row gap="sm">
                <Button
                  variant="danger"
                  disabled={
                    actionInflight !== null ||
                    !canConfirm ||
                    blockingReason !== null ||
                    hardBlockReason !== null
                  }
                  onClick={() => void handleArchive()}
                >
                  {actionInflight === 'archive' ? 'Archiving…' : 'Archive space'}
                </Button>
              </Row>
            </Column>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Column gap="xs">
              <Row gap="sm" align="center">
                <Text size="lg">
                  <strong>Permanently delete</strong>
                </Text>
                <Badge variant="neutral">Archive first</Badge>
              </Row>
              <Text size="sm" variant="muted">
                {preview?.isGeneralSpace
                  ? 'The General space cannot be permanently deleted.'
                  : 'Permanent deletion (purge) erases this space and everything in it — ' +
                    'sessions, runs, agents, skills, memory, and integrations — with no ' +
                    'recovery. It is only available after the space is archived: archive ' +
                    'it here, then purge it from the Archived spaces list.'}
              </Text>
              {!preview?.isGeneralSpace && (
                <Link href="/spaces/archived">
                  <Button variant="secondary">Go to Archived spaces →</Button>
                </Link>
              )}
            </Column>
          </CardBody>
        </Card>
      </Column>
    </PageContainer>
  );
}
