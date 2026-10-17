'use client';

import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Heading,
  HelperText,
  Row,
  Text,
} from '@aflow/design-system';
import {
  LOCAL_MODEL_ROLES,
  type EntityDirectives,
  type LocalModelDiagnosis,
  type LocalRuntimeDiagnostics,
  type LocalRuntimeIssue,
} from '@aflow/schemas';
import { useApiMutation } from '../../hooks/useApiQuery.js';
import { useSpaceDetail } from '../../hooks/use-space-detail.js';
import { everyRoleOn, localModelsQueryKey, useLocalModels } from '../../hooks/useLocalModels.js';
import { llmReadinessQueryKey } from '../../hooks/useSpaceLlmReadiness.js';
import { describeLocalFit } from '../cybernetic/ModelDefaultsEditor.js';

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

const SEVERITY_BADGE: Record<LocalRuntimeIssue['severity'], 'danger' | 'warning' | 'neutral'> = {
  error: 'danger',
  warning: 'warning',
  info: 'neutral',
};

/**
 * Models on this computer (Plan 323 D10, D15): what the runtime holds, what is
 * wrong with it and the fix for each, and every lifecycle action — none of
 * which needs a working model, since the model may be what is not working.
 * Local edition only, like the page it sits on.
 */
export function HostLocalModels({ spaceId }: { spaceId: string }) {
  const { diagnostics, isLoading, act, stopPull } = useLocalModels(spaceId, true);
  const { space } = useSpaceDetail(spaceId);
  const [deleting, setDeleting] = useState<LocalModelDiagnosis | null>(null);

  const assignAll = useApiMutation<EntityDirectives>({
    path: () => `/spaces/${spaceId}`,
    method: 'PATCH',
    serialize: (directives) => JSON.stringify({ directives }),
    spaceId,
    invalidate: [['space', spaceId], localModelsQueryKey(spaceId), llmReadinessQueryKey(spaceId)],
  });

  const useForEveryRole = (modelId: string): void => {
    const model = diagnostics?.models.find((m) => m.model === modelId);
    const directives = space?.directives as EntityDirectives | null | undefined;
    if (model && directives) assignAll.mutate(everyRoleOn(directives, model));
  };

  const runRemedy = (issue: LocalRuntimeIssue): void => {
    if (issue.remedy.kind !== 'action') return;
    const { action } = issue.remedy;
    if (action.action === 'use_for_every_role') useForEveryRole(action.model);
    else act.mutate(action);
  };

  return (
    <Column gap="sm">
      <Heading level={3}>Models on this computer</Heading>
      {isLoading ? (
        <Text variant="muted">Asking Ollama…</Text>
      ) : diagnostics === null ? (
        <Text variant="muted">
          No Ollama connection yet. Add one under Settings → Credentials, and models running on this
          computer can answer for any role.
        </Text>
      ) : (
        <>
          <RuntimeLine diagnostics={diagnostics} />
          {act.error && <HelperText>{act.error.message}</HelperText>}
          {diagnostics.issues.map((issue) => (
            <Card key={`${issue.code}:${issue.model ?? ''}`}>
              <CardBody>
                <Column gap="xs">
                  <Row gap="sm" align="center">
                    <Badge variant={SEVERITY_BADGE[issue.severity]}>{issue.severity}</Badge>
                    <Text size="sm">{issue.cause}</Text>
                  </Row>
                  {issue.remedy.kind === 'action' ? (
                    <Row>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={act.isPending || assignAll.isPending}
                        onClick={() => {
                          runRemedy(issue);
                        }}
                      >
                        {issue.remedy.label}
                      </Button>
                    </Row>
                  ) : (
                    <HelperText>{issue.remedy.text}</HelperText>
                  )}
                </Column>
              </CardBody>
            </Card>
          ))}
          {diagnostics.runtime.reachable &&
            diagnostics.models.map((model) => (
              <ModelRow
                key={model.model}
                model={model}
                diagnostics={diagnostics}
                busy={act.isPending}
                onAct={(action) => {
                  act.mutate({ action, model: model.model });
                }}
                onStop={() => {
                  stopPull.mutate(model.model);
                }}
                onDelete={() => {
                  setDeleting(model);
                }}
                onUseEverywhere={() => {
                  useForEveryRole(model.model);
                }}
              />
            ))}
        </>
      )}
      <Dialog
        open={deleting !== null}
        onClose={() => {
          setDeleting(null);
        }}
        title={`Delete ${deleting?.displayName ?? ''}?`}
        width="sm"
        footer={
          <Row gap="2" justify="end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setDeleting(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={act.isPending}
              onClick={() => {
                if (deleting) act.mutate({ action: 'delete', model: deleting.model });
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </Row>
        }
      >
        <Text size="sm">
          {deleting && deleting.roles.length > 0
            ? `${deleting.roles.join(', ')} use this model and cannot run until it is downloaded again. `
            : ''}
          Downloading it again takes{' '}
          {deleting?.downloadBytes ? gb(deleting.downloadBytes) : 'its size'} of transfer.
        </Text>
      </Dialog>
    </Column>
  );
}

function RuntimeLine({ diagnostics }: { diagnostics: LocalRuntimeDiagnostics }) {
  const { runtime, machine } = diagnostics;
  if (!runtime.reachable) return null;
  const parts = [`Ollama ${runtime.version ?? ''} at ${runtime.baseUrl}`];
  if (machine?.gpuWorkingSetBytes) parts.push(`${gb(machine.gpuWorkingSetBytes)} of GPU memory`);
  if (machine?.freeDiskBytes !== null && machine?.freeDiskBytes !== undefined) {
    parts.push(`${gb(machine.freeDiskBytes)} free on disk`);
  }
  return (
    <Text variant="muted" size="sm">
      {parts.join(' · ')}
    </Text>
  );
}

function ModelRow({
  model,
  diagnostics,
  busy,
  onAct,
  onStop,
  onDelete,
  onUseEverywhere,
}: {
  model: LocalModelDiagnosis;
  diagnostics: LocalRuntimeDiagnostics;
  busy: boolean;
  onAct: (action: 'pull' | 'warm' | 'unload') => void;
  onStop: () => void;
  onDelete: () => void;
  onUseEverywhere: () => void;
}) {
  const downloading = model.pull?.status === 'downloading';
  const everyRole = model.roles.length === LOCAL_MODEL_ROLES.length;
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="sm" align="center" style={{ flexWrap: 'wrap' }}>
            <Text weight="medium">{model.displayName}</Text>
            <Badge variant="neutral">{model.tag}</Badge>
            {model.installed ? (
              <Badge variant="success">
                downloaded{model.downloadBytes ? `, ${gb(model.downloadBytes)}` : ''}
              </Badge>
            ) : (
              <Badge variant="neutral">
                not downloaded{model.downloadBytes ? `, ${gb(model.downloadBytes)}` : ''}
              </Badge>
            )}
            {model.build === 'unverified' && <Badge variant="warning">unmeasured build</Badge>}
            {model.roles.length > 0 && <Badge variant="info">{model.roles.join(', ')}</Badge>}
          </Row>
          <Text variant="muted" size="sm">
            {describeLocalFit({
              ...model.fit,
              gpuWorkingSetBytes: diagnostics.machine?.gpuWorkingSetBytes ?? null,
              runtimeReachable: true,
              loadedBytes: model.loaded?.sizeBytes ?? null,
            })}
          </Text>
          {model.loaded && (
            <Text variant="muted" size="sm">
              Loaded, {gb(model.loaded.sizeBytes)}
              {model.loaded.gpuBytes !== null && model.loaded.gpuBytes < model.loaded.sizeBytes
                ? `, ${gb(model.loaded.sizeBytes - model.loaded.gpuBytes)} of it on the CPU`
                : ''}
              .
            </Text>
          )}
          {model.pull && <PullLine pull={model.pull} />}
          <Row gap="sm" style={{ flexWrap: 'wrap' }}>
            {downloading ? (
              <Button size="sm" variant="secondary" onClick={onStop}>
                Stop download
              </Button>
            ) : !model.installed ? (
              <Button
                size="sm"
                loading={busy}
                onClick={() => {
                  onAct('pull');
                }}
              >
                {model.pull?.status === 'interrupted' ? 'Resume download' : 'Download'}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy}
                  onClick={() => {
                    onAct(model.loaded ? 'unload' : 'warm');
                  }}
                >
                  {model.loaded ? 'Unload' : 'Load now'}
                </Button>
                {!everyRole && (
                  <Button size="sm" variant="secondary" onClick={onUseEverywhere}>
                    Use for every role
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={onDelete}>
                  Delete
                </Button>
              </>
            )}
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}

function PullLine({ pull }: { pull: NonNullable<LocalModelDiagnosis['pull']> }) {
  const percent =
    pull.totalBytes && pull.totalBytes > 0
      ? Math.floor((100 * pull.completedBytes) / pull.totalBytes)
      : null;
  const text =
    pull.status === 'downloading'
      ? `Downloading${percent !== null ? ` — ${percent}% of ${gb(pull.totalBytes ?? 0)}` : '…'}${
          pull.detail ? ` (${pull.detail})` : ''
        }`
      : pull.status === 'interrupted'
        ? 'Download stopped. Downloading again resumes from what is already here.'
        : `Download failed: ${pull.error ?? 'the runtime gave no reason'}. Downloading again resumes from what is already here.`;
  return (
    <Text
      variant="muted"
      size="sm"
      style={pull.status === 'failed' ? { color: 'var(--color-status-warning)' } : undefined}
    >
      {text}
    </Text>
  );
}
