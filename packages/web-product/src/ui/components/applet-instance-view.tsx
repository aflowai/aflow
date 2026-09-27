'use client';

/**
 * AppletInstanceView — mounts a durable applet instance's view and bridges it
 * to the platform: state pushes into the iframe, action commands out to the
 * gateway, results back in. The iframe never sees the HTTP surface; it speaks
 * only the phoenix:* postMessage protocol.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Column, EmptyState, Icon, Row, Spinner, Text } from '@aflow/design-system';
import {
  PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
  PHOENIX_APPLET_STATE_MESSAGE_TYPE,
  PhoenixAppletActionMessageSchema,
  type AppletActionReceipt,
  type AppletCommand,
  type PhoenixAppletActionResultMessage,
  type PhoenixAppletStateMessage,
} from '@aflow/schemas';
import { useApi } from './providers.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { useArtifactVersionView } from '../hooks/use-artifact-version-view.js';
import { useAppletInstance, type AppletInstanceSnapshot } from '../hooks/use-applet-instance.js';
import { readRefusalDetail, type AppletRefusalDetail } from '../lib/applet-refusal.js';
import { createAppletMediaResponder } from '../lib/applet-media.js';
import { ArtifactRenderer, type ArtifactFrameApi } from './artifact-renderer.js';
import { ApiError } from '../lib/query-client.js';

interface ActionAppliedResponse {
  receipt: AppletActionReceipt;
  stateVersion: number;
  replayed: boolean;
}

type SendOutcome =
  { kind: 'applied'; applied: ActionAppliedResponse } | { kind: 'failed'; error: ApiError };

export interface AppletInstanceViewProps {
  spaceId: string | undefined;
  instanceId: string;
}

/** Height an applet board occupies before its content reports its own. */
export const APPLET_MIN_HEIGHT = 320;

export function AppletInstanceView({ spaceId, instanceId }: AppletInstanceViewProps) {
  const { apiUrl, headers } = useApi();
  const {
    snapshot,
    renderedState,
    isLoading,
    error,
    refetch,
    applyOptimistic,
    dropOptimistic,
    confirmReceipt,
  } = useAppletInstance(spaceId, instanceId);

  const frameApiRef = useRef<ArtifactFrameApi | null>(null);
  const [readyTick, setReadyTick] = useState(0);
  const [conflict, setConflict] = useState(false);

  const actionMutation = useApiMutation<AppletCommand, ActionAppliedResponse>({
    path: () => `/applets/${instanceId}/actions`,
    ...(spaceId ? { spaceId } : {}),
    // Errors surface through the action-result protocol, not a toast.
    onError: () => undefined,
  });

  // Keyed by the artifact version, which is what the html belongs to — an
  // upgrade repins the instance to another version and the view follows without
  // anything being invalidated.
  const versionId = snapshot?.instance?.artifactVersionId;
  const view = useArtifactVersionView(spaceId, versionId);
  const html = view.data?.html ?? null;
  const htmlError = view.error === null ? null : (view.error?.message ?? null);

  // Push the current state into the iframe on every change and on every
  // iframe (re)load — the shell stamps baseVersion from the last push.
  useEffect(() => {
    if (readyTick === 0) return;
    if (!snapshot || renderedState === undefined) return;
    const message: PhoenixAppletStateMessage = {
      type: PHOENIX_APPLET_STATE_MESSAGE_TYPE,
      state: renderedState,
      version: snapshot.stateVersion,
      viewer: snapshot.viewer,
      ...(snapshot.seats !== undefined ? { seats: snapshot.seats } : {}),
    };
    frameApiRef.current?.postMessage(message);
  }, [readyTick, snapshot, renderedState]);

  const postResult = useCallback((message: PhoenixAppletActionResultMessage) => {
    frameApiRef.current?.postMessage(message);
  }, []);

  const mediaResponder = useMemo(
    () => createAppletMediaResponder({ apiUrl, headers }),
    [apiUrl, headers],
  );

  useEffect(
    () => () => {
      mediaResponder.reset();
    },
    [mediaResponder],
  );

  const handleMediaRequest = useCallback(
    async (event: Record<string, unknown>) => {
      // The authoritative state decides what the view may see. Not
      // `renderedState`: its optimistic layer is the view's own writing, so a
      // view could name any document there and then ask to read it.
      const result = await mediaResponder.answer(event, snapshot?.state);
      if (result) frameApiRef.current?.postMessage(result);
    },
    [mediaResponder, snapshot],
  );

  const send = useCallback(
    async (command: AppletCommand): Promise<SendOutcome> => {
      try {
        const applied = await actionMutation.mutateAsync(command);
        return { kind: 'applied', applied };
      } catch (err) {
        if (err instanceof ApiError) return { kind: 'failed', error: err };
        throw err;
      }
    },
    [actionMutation],
  );

  const handleAction = useCallback(
    async (event: Record<string, unknown>) => {
      const parsed = PhoenixAppletActionMessageSchema.safeParse(event);
      if (!parsed.success) {
        // The shell already registered a resolver for this actionId — a silent
        // drop would hang the view's promise forever, so refuse explicitly.
        const actionId = (event as { actionId?: unknown }).actionId;
        if (typeof actionId === 'string') {
          postResult({
            type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
            actionId,
            status: 'rejected',
            reason: 'invalid_command',
            message: 'The command the view sent is not a valid action envelope.',
            validation: parsed.error.issues.map(
              (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
            ),
          });
        }
        return;
      }
      if (!snapshot) return;
      const { type: _type, silent, ...command } = parsed.data;
      const rejected = (detail: AppletRefusalDetail): PhoenixAppletActionResultMessage => ({
        type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
        actionId: command.actionId,
        status: 'rejected',
        ...detail,
      });

      if (snapshot.viewer.spaceRole === 'viewer') {
        postResult(
          rejected({
            reason: 'forbidden',
            message: 'You have view-only access to this space, so this change was not applied.',
          }),
        );
        return;
      }

      if (command.proposedPatch) applyOptimistic(command.actionId, command.proposedPatch);

      // No blind resubmit on 409: an actor-supplied patch was computed against
      // a specific state and is meaningless against another — resending it at
      // a fresh baseVersion silently applies a stale change. The view gets the
      // conflict plus fresh state and recomputes its intent.
      let outcome: SendOutcome;
      try {
        outcome = await send(command);
      } catch (err) {
        // Network-level failure (offline, reset): no response ever arrived, so
        // settle the promise and drop the overlay the server never saw.
        dropOptimistic(command.actionId);
        postResult(
          rejected({
            reason: 'request_failed',
            message: err instanceof Error ? err.message : 'The request never reached the platform.',
          }),
        );
        return;
      }

      if (outcome.kind === 'applied') {
        confirmReceipt(outcome.applied.receipt, outcome.applied.stateVersion);
        postResult({
          type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
          actionId: command.actionId,
          status: 'applied',
          receipt: outcome.applied.receipt,
        });
        return;
      }

      dropOptimistic(command.actionId);
      const { status, body } = outcome.error;
      if (status === 409) {
        const currentVersion = (body as { currentVersion?: unknown } | undefined)?.currentVersion;
        postResult({
          type: PHOENIX_APPLET_ACTION_RESULT_MESSAGE_TYPE,
          actionId: command.actionId,
          status: 'conflict',
          ...(typeof currentVersion === 'number' ? { currentVersion } : {}),
        });
        // Bookkeeping the view fires on its own loses CAS races routinely —
        // a banner for that reads as a problem where none exists.
        if (silent !== true) setConflict(true);
        void refetch();
        return;
      }
      // A 403 body names no reason — the status is the reason. Whatever the
      // gateway did say wins over both defaults; the fallback message only
      // fills a gap, so a refusal never reaches the view with nothing on it.
      const refusal = readRefusalDetail(body);
      postResult(
        rejected({
          ...(status === 403 ? { reason: 'forbidden' } : {}),
          ...refusal,
          ...(refusal.message === undefined
            ? { message: `The platform refused the change (HTTP ${status}).` }
            : {}),
        }),
      );
    },
    [snapshot, send, refetch, postResult, applyOptimistic, dropOptimistic, confirmReceipt],
  );

  if (isLoading) {
    return (
      <Row gap="sm" align="center" padding="md">
        <Spinner size="sm" />
        <Text size="sm" color="muted">
          Loading applet…
        </Text>
      </Row>
    );
  }

  if (error || !snapshot) {
    return (
      <EmptyState
        icon={<Icon name="warning" />}
        title="Applet unavailable"
        description={error?.message ?? 'This applet instance could not be loaded.'}
      />
    );
  }

  const definitionName = snapshot.definition['name'];
  const displayName =
    typeof definitionName === 'string' && definitionName.length > 0
      ? definitionName
      : snapshot.instance.appletKey;
  const isViewOnly = snapshot.viewer.spaceRole === 'viewer';

  return (
    <Column gap="md">
      <Row gap="sm" align="center" wrap>
        <Text size="lg" weight="semibold">
          {displayName}
        </Text>
        <Badge variant={snapshot.instance.status === 'active' ? 'success' : 'neutral'}>
          {snapshot.instance.status}
        </Badge>
        <Text size="xs" color="muted">
          v{snapshot.stateVersion}
        </Text>
        {/* Two live instances of the same applet are otherwise pixel-identical
            — the short id + start time is what tells two games apart. */}
        <Text size="xs" color="muted">
          #{snapshot.instance.instanceId.slice(0, 6)} · started{' '}
          {new Date(snapshot.instance.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </Text>
        {snapshot.viewer.appletRoles.map((role) => (
          <Badge key={role} variant="info">
            {role}
          </Badge>
        ))}
      </Row>

      {isViewOnly && (
        <Row
          gap="sm"
          align="center"
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border-subtle)',
            background: 'var(--color-surface-2)',
          }}
        >
          <Icon name="eye" size="sm" />
          <Text size="sm" color="muted">
            You have view-only access to this space. You can watch this applet, but only editors can
            act on it.
          </Text>
        </Row>
      )}

      {conflict && (
        <Row
          gap="sm"
          align="center"
          style={{
            padding: 'var(--space-3) var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-warning-default)',
            background: 'var(--color-warning-bg)',
          }}
        >
          <Icon name="warning" size="sm" />
          <Text size="sm">
            Someone else changed this applet while your action was in flight. The view has been
            refreshed — try again from the current state.
          </Text>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConflict(false);
            }}
          >
            Dismiss
          </Button>
        </Row>
      )}

      {html ? (
        <ArtifactRenderer
          html={html}
          minHeight={APPLET_MIN_HEIGHT}
          maxHeight={1400}
          metadata={{
            kind: 'applet',
            name: displayName,
            versionId: snapshot.instance.artifactVersionId,
          }}
          onAction={(event) => {
            void handleAction(event);
          }}
          onMediaRequest={(event) => {
            void handleMediaRequest(event);
          }}
          onMediaRelease={(event) => {
            mediaResponder.release(event);
          }}
          onReady={() => {
            // A reloaded document lost the object URLs it minted, so the bytes
            // behind them are held for nobody.
            mediaResponder.reset();
            setReadyTick((tick) => tick + 1);
          }}
          frameApiRef={frameApiRef}
        />
      ) : (
        <EmptyState
          icon={<Icon name="squares-four" />}
          title="View unavailable"
          description={
            htmlError ?? (view.isLoading ? 'Loading the applet view…' : 'No view to show yet.')
          }
        />
      )}
    </Column>
  );
}

export type { AppletInstanceSnapshot };
