'use client';

import { useMemo } from 'react';
import { Badge, Button, Card, CardBody, Column, Icon, Row, Text } from '@aflow/design-system';
import type {
  StoreArtifactDivergence,
  StoreUpdateMode,
  StoreUpdatePreviewResponse,
  StoreUpdateResponse,
} from '@aflow/schemas';
import { SetupChecklist } from '../setup-checklist.js';
import { spaceRoute } from '../../lib/space-routes.js';
import { unifiedDiffLines } from '../../lib/line-diff.js';
import { ARTIFACT_TYPE_LABELS } from './labels';

// ---------------------------------------------------------------------------
// Update flow state machine: idle → previewing → confirm (pristine, one-click)
// or choose (customized, Replace/Keep) → updating → done, with failed (retry
// reuses the attempt's idempotencyKey). A successful Keep returns to idle
// with a page notice — nothing changed in the space.
// ---------------------------------------------------------------------------

export type UpdateFlow =
  | { phase: 'idle' }
  | { phase: 'previewing' }
  | {
      phase: 'confirm';
      preview: StoreUpdatePreviewResponse;
      idempotencyKey: string;
      notice: string | null;
    }
  | {
      phase: 'choose';
      preview: StoreUpdatePreviewResponse;
      idempotencyKey: string;
      notice: string | null;
    }
  | {
      phase: 'updating';
      preview: StoreUpdatePreviewResponse;
      idempotencyKey: string;
      mode: StoreUpdateMode;
    }
  | {
      phase: 'failed';
      preview: StoreUpdatePreviewResponse;
      idempotencyKey: string;
      mode: StoreUpdateMode;
      message: string;
      details: string[];
    }
  | { phase: 'done'; response: StoreUpdateResponse };

const DIFF_LINE_PREFIX = { context: '  ', added: '+ ', removed: '- ', skip: '' } as const;

function MineVsStoreDiff({ contents }: { contents: { mine: string; store: string } }) {
  const lines = useMemo(
    () => unifiedDiffLines(contents.mine, contents.store),
    [contents.mine, contents.store],
  );
  return (
    <pre
      style={{
        fontSize: 11,
        padding: 'var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-1)',
        overflow: 'auto',
        maxHeight: 240,
        margin: 0,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={line.kind === 'context' || line.kind === 'skip' ? { opacity: 0.6 } : {}}
        >
          {DIFF_LINE_PREFIX[line.kind]}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

function DivergedArtifactRow({
  artifact,
  artifactName,
}: {
  artifact: StoreArtifactDivergence;
  artifactName: (artifactKey: string) => string;
}) {
  return (
    <Column gap="xs">
      <Row gap="sm" align="center">
        <Icon name="pencil" size="xs" />
        <Badge variant="neutral">{ARTIFACT_TYPE_LABELS[artifact.artifactType]}</Badge>
        <Text size="xs" truncate style={{ flex: 1 }}>
          {artifactName(artifact.artifactKey)}
        </Text>
        <Badge variant="warning">
          {artifact.state === 'missing' ? 'Removed by you' : 'Changed by you'}
        </Badge>
      </Row>
      {artifact.contents && (
        <details>
          <summary style={{ cursor: 'pointer' }}>
            <Text size="xs" variant="muted">
              Compare mine vs Store version
            </Text>
          </summary>
          <MineVsStoreDiff contents={artifact.contents} />
        </details>
      )}
      {artifact.contentsTruncated && (
        <Text size="xs" variant="muted">
          Too large to show the changes here.
        </Text>
      )}
    </Column>
  );
}

export function UpdateDialogBody({
  flow,
  entryName,
  artifactName,
}: {
  flow: Extract<UpdateFlow, { phase: 'confirm' | 'choose' | 'updating' | 'failed' }>;
  entryName: string;
  artifactName: (artifactKey: string) => string;
}) {
  const { preview } = flow;
  const customized = preview.divergence.customized;
  const diverged = preview.divergence.artifacts.filter((a) => a.state !== 'pristine');
  const notice = flow.phase === 'confirm' || flow.phase === 'choose' ? flow.notice : null;

  return (
    <Column gap="md">
      {notice && (
        <Row gap="sm" align="center">
          <Icon name="info" size="sm" />
          <Text size="sm">{notice}</Text>
        </Row>
      )}

      {flow.phase === 'failed' && (
        <Card>
          <CardBody>
            <Column gap="xs">
              <Row gap="sm" align="center">
                <Icon name="warning" size="sm" />
                <Text size="sm" weight="medium">
                  Update failed
                </Text>
              </Row>
              <Text size="xs" variant="muted">
                {flow.message}
              </Text>
              {flow.details.map((line, i) => (
                <Row key={i} gap="xs" align="start">
                  <Icon name="warning" size="xs" />
                  <Text size="xs">{line}</Text>
                </Row>
              ))}
            </Column>
          </CardBody>
        </Card>
      )}

      <Row gap="sm" align="center">
        <Icon name="arrow-up" size="sm" />
        <Text size="sm">
          {entryName}: version {String(preview.currentVersion)} &rarr; version{' '}
          {String(preview.catalogVersion)}
        </Text>
      </Row>

      {customized ? (
        <>
          <Column gap="xs">
            <Text size="sm" weight="medium">
              Changed since you installed
            </Text>
            {diverged.map((artifact) => (
              <DivergedArtifactRow
                key={`${artifact.artifactType}:${artifact.artifactKey}`}
                artifact={artifact}
                artifactName={artifactName}
              />
            ))}
          </Column>
          <Column gap="xs">
            <Text size="xs" variant="muted">
              Replace with Store version — the items above become the Store&rsquo;s version{' '}
              {String(preview.catalogVersion)} and your changes are discarded.
            </Text>
            <Text size="xs" variant="muted">
              Keep mine — everything stays as it is, and the update badge clears until the next
              version arrives.
            </Text>
          </Column>
        </>
      ) : (
        <>
          {preview.divergence.artifacts.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                What changes
              </Text>
              {preview.divergence.artifacts.map((artifact) => (
                <Row
                  key={`${artifact.artifactType}:${artifact.artifactKey}`}
                  gap="sm"
                  align="center"
                >
                  <Icon name="arrow-up" size="xs" />
                  <Badge variant="neutral">{ARTIFACT_TYPE_LABELS[artifact.artifactType]}</Badge>
                  <Text size="xs" truncate>
                    {artifactName(artifact.artifactKey)}
                  </Text>
                </Row>
              ))}
            </Column>
          )}
          <Text size="xs" variant="muted">
            Your connections and anything you&rsquo;ve added stay in place.
          </Text>
        </>
      )}
    </Column>
  );
}

export function UpdateSuccessView({
  response,
  spaceSlug,
  openPath,
  onNavigate,
  artifactName,
}: {
  response: StoreUpdateResponse;
  spaceSlug: string;
  openPath: string;
  onNavigate: (path: string) => void;
  artifactName: (artifactKey: string) => string;
}) {
  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center">
            <Icon name="check-circle" size="sm" />
            <Text size="sm" weight="medium">
              Updated to version {String(response.toVersion)}
            </Text>
          </Row>

          {response.updatedArtifacts.length > 0 && (
            <Column gap="xs">
              {response.updatedArtifacts.map((artifact) => (
                <Row
                  key={`${artifact.artifactType}:${artifact.artifactKey}`}
                  gap="sm"
                  align="center"
                >
                  <Icon name={artifact.action === 'installed' ? 'plus' : 'arrow-up'} size="xs" />
                  <Badge variant="neutral">{ARTIFACT_TYPE_LABELS[artifact.artifactType]}</Badge>
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {artifactName(artifact.artifactKey)}
                  </Text>
                  <Badge variant="neutral">
                    {artifact.action === 'installed' ? 'Added' : 'Updated'}
                  </Badge>
                </Row>
              ))}
            </Column>
          )}

          {response.orphanedArtifacts.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                No longer part of this listing
              </Text>
              {response.orphanedArtifacts.map((artifact) => (
                <Row
                  key={`${artifact.artifactType}:${artifact.artifactKey}`}
                  gap="sm"
                  align="center"
                >
                  <Badge variant="neutral">{ARTIFACT_TYPE_LABELS[artifact.artifactType]}</Badge>
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {artifactName(artifact.artifactKey)}
                  </Text>
                  <Text size="xs" variant="muted">
                    Kept in your space
                  </Text>
                </Row>
              ))}
            </Column>
          )}

          {response.credentialsReset && (
            <Row gap="sm" align="center">
              <Icon name="warning" size="sm" />
              <Text size="xs">
                This version signs in differently, so your connection needs to be set up again.
              </Text>
            </Row>
          )}

          {response.missingVariables.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Still needs setup
              </Text>
              {response.missingVariables.map((variable) => (
                <Row key={variable} gap="sm" align="center">
                  <Icon name="plugs" size="xs" />
                  <Text size="xs">{variable}</Text>
                </Row>
              ))}
            </Column>
          )}

          {response.setupChecklist.length > 0 && (
            <Column gap="sm">
              <Text size="sm" weight="medium">
                Setup checklist
              </Text>
              <SetupChecklist
                tasks={response.setupChecklist}
                spaceSlug={spaceSlug}
                onNavigate={onNavigate}
              />
            </Column>
          )}

          {(response.credentialsReset || response.missingVariables.length > 0) &&
            response.setupChecklist.length === 0 && (
              <Row>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onNavigate(spaceRoute(spaceSlug, '/integrations'));
                  }}
                >
                  Open Integrations
                </Button>
              </Row>
            )}

          <Row>
            <Button
              variant="primary"
              onClick={() => {
                onNavigate(spaceRoute(spaceSlug, openPath));
              }}
            >
              Open
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
