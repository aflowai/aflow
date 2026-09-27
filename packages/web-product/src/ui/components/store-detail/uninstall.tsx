'use client';

import {
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  Column,
  Icon,
  Row,
  Text,
} from '@aflow/design-system';
import type {
  StoreArtifactType,
  StoreUninstallPreviewResponse,
  StoreUninstallResponse,
} from '@aflow/schemas';
import { spaceRoute } from '../../lib/space-routes.js';
import { ARTIFACT_TYPE_LABELS } from './labels';

// ---------------------------------------------------------------------------
// Uninstall flow state machine: idle → previewing → confirm (blast radius +
// keep-my-data checkboxes) → removing → done, with failed (retry reuses the
// attempt's idempotencyKey).
// ---------------------------------------------------------------------------

export type UninstallFlow =
  | { phase: 'idle' }
  | { phase: 'previewing' }
  | {
      phase: 'confirm';
      preview: StoreUninstallPreviewResponse;
      idempotencyKey: string;
      keep: Record<string, boolean>;
      notice: string | null;
    }
  | {
      phase: 'removing';
      preview: StoreUninstallPreviewResponse;
      idempotencyKey: string;
      keep: Record<string, boolean>;
    }
  | {
      phase: 'failed';
      preview: StoreUninstallPreviewResponse;
      idempotencyKey: string;
      keep: Record<string, boolean>;
      message: string;
    }
  | { phase: 'done'; response: StoreUninstallResponse };

export function defaultKeepChoices(
  preview: StoreUninstallPreviewResponse,
): Record<string, boolean> {
  const keep: Record<string, boolean> = {};
  for (const artifact of preview.artifacts) {
    if (artifact.userDataRemovable) keep[artifact.artifactKey] = true;
  }
  return keep;
}

const USER_DATA_TYPES: ReadonlySet<StoreArtifactType> = new Set(['memory_doc', 'ui_artifact']);
const CONNECTION_TYPES: ReadonlySet<StoreArtifactType> = new Set(['api_binding', 'mcp_binding']);

export function UninstallDialogBody({
  flow,
  entryName,
  artifactName,
  claimLabel,
  memberName,
  onToggleKeep,
}: {
  flow: Extract<UninstallFlow, { phase: 'confirm' | 'removing' | 'failed' }>;
  entryName: string;
  artifactName: (artifactKey: string) => string;
  claimLabel: (claimant: string) => string;
  memberName: (memberCatalogId: string) => string;
  onToggleKeep: (artifactKey: string, value: boolean) => void;
}) {
  const preview = flow.preview;
  const skills = preview.artifacts.filter(
    (artifact) => artifact.artifactType === 'skill' && artifact.action !== 'missing',
  );
  const integrations = preview.artifacts.filter(
    (artifact) =>
      (artifact.artifactType === 'api_definition' || artifact.artifactType === 'mcp_definition') &&
      artifact.action !== 'missing',
  );
  const connections = preview.artifacts.filter(
    (artifact) => CONNECTION_TYPES.has(artifact.artifactType) && artifact.action === 'disable',
  );
  const userData = preview.artifacts.filter(
    (artifact) => USER_DATA_TYPES.has(artifact.artifactType) && artifact.action !== 'missing',
  );
  const staying = preview.members.filter((member) => member.action === 'stays');
  const blockedSkills = skills.filter((artifact) => (artifact.activeRunCount ?? 0) > 0);

  return (
    <Column gap="md">
      {flow.phase === 'confirm' && flow.notice && (
        <Row gap="sm" align="center">
          <Icon name="info" size="sm" />
          <Text size="sm">{flow.notice}</Text>
        </Row>
      )}

      {flow.phase === 'failed' && (
        <Card>
          <CardBody>
            <Row gap="sm" align="center">
              <Icon name="warning" size="sm" />
              <Text size="sm">{flow.message}</Text>
            </Row>
          </CardBody>
        </Card>
      )}

      {preview.action === 'release_claim' ? (
        <Column gap="xs">
          <Text size="sm">
            {entryName} is part of{' '}
            {preview.remainingClaims.map((claim) => claimLabel(claim)).join(', ')}, so it stays
            installed. This only removes your direct install of it.
          </Text>
        </Column>
      ) : (
        <>
          {blockedSkills.length > 0 && (
            <Card>
              <CardBody>
                <Row gap="sm" align="start">
                  <Icon name="warning" size="sm" />
                  <Text size="sm">
                    {blockedSkills
                      .map(
                        (artifact) =>
                          `${artifactName(artifact.artifactKey)} still has ${String(artifact.activeRunCount)} active run(s)`,
                      )
                      .join('; ')}
                    . Stop them before uninstalling.
                  </Text>
                </Row>
              </CardBody>
            </Card>
          )}

          {skills.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Skills
              </Text>
              {skills.map((artifact) => (
                <Row key={artifact.artifactKey} gap="sm" align="center">
                  <Icon name="folder-simple" size="xs" />
                  <Text size="xs" style={{ flex: 1 }} truncate>
                    {artifactName(artifact.artifactKey)}
                  </Text>
                  <Badge variant="neutral">Archived — restorable</Badge>
                </Row>
              ))}
            </Column>
          )}

          {integrations.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Integrations
              </Text>
              {integrations.map((artifact) => (
                <Column key={artifact.artifactKey} gap="xs">
                  <Row gap="sm" align="center">
                    <Icon name={artifact.action === 'delete' ? 'trash' : 'pause'} size="xs" />
                    <Text size="xs" style={{ flex: 1 }} truncate>
                      {artifactName(artifact.artifactKey)}
                    </Text>
                    <Badge variant="neutral">
                      {artifact.action === 'delete'
                        ? 'Removed with its connection'
                        : 'Turned off, kept'}
                    </Badge>
                  </Row>
                  {artifact.action === 'disable' && (artifact.dependentSkills?.length ?? 0) > 0 && (
                    <Text size="xs" variant="muted">
                      Still used by: {artifact.dependentSkills?.join(', ')}
                    </Text>
                  )}
                  {artifact.action === 'disable' && (artifact.dependentRepoCount ?? 0) > 0 && (
                    <Text size="xs" variant="muted">
                      Still backs {String(artifact.dependentRepoCount)} coding repositor
                      {artifact.dependentRepoCount === 1 ? 'y' : 'ies'}.
                    </Text>
                  )}
                </Column>
              ))}
            </Column>
          )}

          {connections.length > 0 && integrations.length === 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Connections
              </Text>
              {connections.map((artifact) => (
                <Row key={artifact.artifactKey} gap="sm" align="center">
                  <Icon name="pause" size="xs" />
                  <Text size="xs" style={{ flex: 1 }} truncate>
                    {artifactName(artifact.artifactKey)}
                  </Text>
                  <Badge variant="neutral">Turned off</Badge>
                </Row>
              ))}
            </Column>
          )}

          {userData.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Your data
              </Text>
              {userData.map((artifact) =>
                artifact.userDataRemovable ? (
                  <Checkbox
                    key={artifact.artifactKey}
                    checked={flow.keep[artifact.artifactKey] ?? true}
                    disabled={flow.phase !== 'confirm'}
                    onChange={(event) => {
                      onToggleKeep(artifact.artifactKey, event.target.checked);
                    }}
                    label={`Keep ${ARTIFACT_TYPE_LABELS[artifact.artifactType].toLowerCase()}: ${artifactName(artifact.artifactKey)}`}
                  />
                ) : (
                  <Row key={artifact.artifactKey} gap="sm" align="center">
                    <Icon name="lock" size="xs" />
                    <Text size="xs" style={{ flex: 1 }} truncate>
                      {artifactName(artifact.artifactKey)}
                    </Text>
                    <Badge variant="neutral">Kept — you changed it</Badge>
                  </Row>
                ),
              )}
            </Column>
          )}

          {staying.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                These stay
              </Text>
              {staying.map((member) => (
                <Row key={member.catalogId} gap="sm" align="center">
                  <Icon name="check-circle" size="xs" />
                  <Text size="xs" style={{ flex: 1 }} truncate>
                    {memberName(member.catalogId)}
                  </Text>
                  <Text size="xs" variant="muted">
                    also {member.remainingClaims.map((claim) => claimLabel(claim)).join(', ')}
                  </Text>
                </Row>
              ))}
            </Column>
          )}
        </>
      )}
    </Column>
  );
}

export function UninstallSuccessView({
  response,
  entryName,
  spaceSlug,
  onNavigate,
  artifactName,
  claimLabel,
}: {
  response: StoreUninstallResponse;
  entryName: string;
  spaceSlug: string;
  onNavigate: (path: string) => void;
  artifactName: (artifactKey: string) => string;
  claimLabel: (claimant: string) => string;
}) {
  const archived = response.artifacts.filter((artifact) => artifact.action === 'archive');
  const disabled = response.artifacts.filter(
    (artifact) =>
      artifact.action === 'disable' &&
      (artifact.artifactType === 'api_definition' || artifact.artifactType === 'mcp_definition'),
  );
  const kept = response.artifacts.filter(
    (artifact) => USER_DATA_TYPES.has(artifact.artifactType) && artifact.action === 'keep',
  );
  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center">
            <Icon name="check-circle" size="sm" />
            <Text size="sm" weight="medium">
              {response.action === 'release_claim'
                ? `${entryName} stays installed — it is still part of ${response.remainingClaims
                    .map((claim) => claimLabel(claim))
                    .join(', ')}.`
                : `${entryName} was uninstalled.`}
            </Text>
          </Row>
          {archived.length > 0 && (
            <Text size="xs" variant="muted">
              Archived (restorable): {archived.map((a) => artifactName(a.artifactKey)).join(', ')}
            </Text>
          )}
          {disabled.length > 0 && (
            <Text size="xs" variant="muted">
              Turned off but kept: {disabled.map((a) => artifactName(a.artifactKey)).join(', ')}
            </Text>
          )}
          {kept.length > 0 && (
            <Text size="xs" variant="muted">
              Your data was kept: {kept.map((a) => artifactName(a.artifactKey)).join(', ')}
            </Text>
          )}
          <Row>
            <Button
              variant="secondary"
              onClick={() => {
                onNavigate(spaceRoute(spaceSlug, '/store'));
              }}
            >
              Back to Store
            </Button>
          </Row>
        </Column>
      </CardBody>
    </Card>
  );
}
