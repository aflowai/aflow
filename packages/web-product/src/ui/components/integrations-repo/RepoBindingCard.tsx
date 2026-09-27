'use client';

import { type ReactNode } from 'react';
import {
  Badge,
  Card,
  CardBody,
  Column,
  Heading,
  Icon,
  IconButton,
  ListingAvatar,
  Row,
  Text,
  Tooltip,
} from '@aflow/design-system';
import { ChipList, DetailRow, DetailsSection, formatJson } from '../integrations-api/helpers.js';
import type { ApiBindingSummary, IntegrationCredentialMeta } from '../../hooks/use-integrations.js';
import type { RepoBindingSummary } from '../../hooks/use-repo-bindings.js';
import { displayCoordinate, effectiveGitCredentialKey, getReadiness } from './repoReadiness.js';
import type { Readiness } from './repoReadiness.js';

function ReadinessBadge({ status }: { status: Readiness }) {
  switch (status) {
    case 'ready':
      return (
        <Badge variant="success">
          <Icon name="check-circle" size="xs" /> Ready
        </Badge>
      );
    case 'needs_credential':
      return (
        <Badge variant="warning">
          <Icon name="key" size="xs" /> Needs credential
        </Badge>
      );
    case 'provisioning':
      return <Badge variant="neutral">Provisioning</Badge>;
    case 'error':
      return (
        <Badge variant="danger">
          <Icon name="warning-circle" size="xs" /> Error
        </Badge>
      );
  }
}

/**
 * One card per repo binding. Surfaces the push policy front-and-centre — the
 * remote, the default branch (which the lane may NEVER push to), the allowed
 * push patterns, and the credential reference — so the operator can see exactly
 * what authority the coding lane has been granted over this repo.
 */
export function RepoBindingCard({
  binding,
  credentialsByKey,
  connectionsById,
  onEdit,
  onArchive,
  kindBadge,
  nested,
  sharedRepoCount,
  readOnly = false,
}: {
  binding: RepoBindingSummary;
  credentialsByKey: Map<string, IntegrationCredentialMeta>;
  connectionsById: Map<string, ApiBindingSummary>;
  onEdit: () => void;
  onArchive: () => void;
  kindBadge?: ReactNode;
  nested?: boolean;
  sharedRepoCount: number;
  /** Viewer-role rendering: status only, no mutation affordances (the server rejects those writes anyway). */
  readOnly?: boolean;
}) {
  const readiness = getReadiness(binding, credentialsByKey, connectionsById);
  const connection = connectionsById.get(binding.connectionBindingId);
  const effectiveKey = effectiveGitCredentialKey(binding, connectionsById);

  return (
    <Card
      style={
        nested
          ? { background: 'var(--color-surface-1)' }
          : { backgroundColor: 'var(--color-surface-2)' }
      }
    >
      <CardBody>
        <Column gap="3">
          {/* Header row */}
          <Column gap="2" style={nested ? undefined : { marginBottom: 'var(--space-xl)' }}>
            <Row gap="2" align="center" wrap>
              {/* The git glyph, never the host's brand mark — a repo binding must
                  not look like an API connection to the same host. */}
              <ListingAvatar
                icon={{ kind: 'phosphor', name: 'git-branch' }}
                name={displayCoordinate(binding.coordinate)}
                kind="repo"
                seed={binding.repoDesignationId}
                size="md"
              />
              <Column gap="0" style={{ minWidth: 0, flex: 1 }}>
                <Row gap="2" align="center" wrap>
                  <Heading level={5}>{displayCoordinate(binding.coordinate)}</Heading>
                  {kindBadge}
                </Row>
                <Text size="sm" color="secondary" truncate>
                  {binding.remoteUrl}
                </Text>
              </Column>
            </Row>
            <Row gap="2" align="center" wrap>
              <Tooltip content="The lane may never push to the default branch.">
                <Badge variant="neutral">
                  <Icon name="git-branch" size="xs" /> {binding.defaultBranch}
                </Badge>
              </Tooltip>
              <Tooltip content="Coding-lane authority — clone, branch, and push only to allowed branches of this repo (never the default branch). Separate from the GitHub API connection, which calls GitHub's REST API.">
                <Badge variant="neutral">
                  <Icon name="file-code" size="xs" /> Coding lane
                </Badge>
              </Tooltip>
              <ReadinessBadge status={readiness} />
              {binding.credentialKey ? (
                <Tooltip content="Per-repo git override">
                  <Badge variant="neutral">
                    <Icon name="key" size="xs" /> {binding.credentialKey} · override
                  </Badge>
                </Tooltip>
              ) : effectiveKey ? (
                <Tooltip
                  content={`Git resolves through the ${connection?.name ?? 'connection'} connection (${effectiveKey}).`}
                >
                  <Badge variant="neutral">
                    <Icon name="key" size="xs" /> via {connection?.name ?? 'connection'}
                  </Badge>
                </Tooltip>
              ) : null}
              {!readOnly && (
                <>
                  <Tooltip content="Edit repository">
                    <IconButton
                      icon={<Icon name="pencil" size="sm" />}
                      aria-label="Edit repository"
                      onClick={onEdit}
                    />
                  </Tooltip>
                  <Tooltip content="Remove repository">
                    <IconButton
                      icon={<Icon name="trash" size="sm" />}
                      aria-label="Remove repository"
                      onClick={onArchive}
                    />
                  </Tooltip>
                </>
              )}
            </Row>
          </Column>

          {binding.description && (
            <Text size="sm" color="secondary">
              {binding.description}
            </Text>
          )}

          {/* Push policy — the most security-relevant surface. */}
          <Column gap="1">
            <Text size="xs" weight="medium" color="secondary">
              Allowed push branches
            </Text>
            {binding.allowedPushBranchPatterns.length > 0 ? (
              <ChipList items={binding.allowedPushBranchPatterns} />
            ) : (
              <Text size="sm" color="secondary">
                None — the lane cannot push to this repo until a pattern is added.
              </Text>
            )}
          </Column>

          <DetailsSection label="Details" rawJson={() => formatJson(binding)}>
            <Column gap="2">
              <DetailRow label="Coordinate">
                <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
                  {binding.coordinate}
                </Text>
              </DetailRow>
              <DetailRow label="Remote">
                <Text
                  size="sm"
                  style={{ fontFamily: 'var(--font-family-mono)', wordBreak: 'break-all' }}
                >
                  {binding.remoteUrl}
                </Text>
              </DetailRow>
              <DetailRow label="Default branch">
                <Badge variant="neutral">{binding.defaultBranch}</Badge>
              </DetailRow>
              <DetailRow label="Credential">
                <Text size="sm" style={{ fontFamily: 'var(--font-family-mono)' }}>
                  {binding.credentialKey
                    ? `${binding.credentialKey} (per-repo override)`
                    : effectiveKey
                      ? `${effectiveKey} (via ${connection?.name ?? 'connection'})`
                      : '— resolves through the GitHub connection'}
                </Text>
              </DetailRow>
              {binding.checkProfiles.length > 0 && (
                <DetailRow label="Check profiles">
                  <ChipList items={binding.checkProfiles.map((p) => p.name)} />
                </DetailRow>
              )}
              {binding.lastErrorCode && (
                <DetailRow label="Last error">
                  <Text size="sm" tone="danger">
                    {binding.lastErrorCode}
                  </Text>
                </DetailRow>
              )}
              <DetailRow label="Created">
                <Text size="sm" color="secondary">
                  {new Date(binding.createdAt).toLocaleString()}
                </Text>
              </DetailRow>
            </Column>
          </DetailsSection>

          {readiness === 'needs_credential' && (
            <Text size="xs" tone="warning">
              {binding.credentialKey ? (
                <>
                  The per-repo git override <strong>{binding.credentialKey}</strong> isn&apos;t
                  usable — either the credential isn&apos;t set in this space, or the{' '}
                  {connection?.name ?? 'GitHub'} connection is disabled. Set the credential (or
                  re-enable the connection), or pick a different one via Edit, before the lane can
                  push.
                </>
              ) : (
                <>
                  The {connection?.name ?? 'GitHub'} connection has no usable git token — it
                  isn&apos;t a bearer connection, has no token set, or is disabled. Add a bearer
                  token to the connection (or set a per-repo git override on this repository) before
                  the lane can push.
                </>
              )}
            </Text>
          )}
          {readiness === 'error' && binding.lastErrorCode && (
            <Text size="xs" tone="danger">
              Last operation failed: {binding.lastErrorCode}. Edit and save again to retry.
            </Text>
          )}
          {!binding.credentialKey && sharedRepoCount >= 2 && readiness === 'ready' && (
            <Row gap="1" align="center">
              <Icon name="info" size="xs" />
              <Text size="xs" color="secondary">
                {sharedRepoCount} repos share this connection&apos;s git token — rotating or
                removing it revokes all of them at once. To isolate this repo, set a per-repo
                override (Edit → git credential) using a GitHub fine-grained PAT scoped to just this
                repository.
              </Text>
            </Row>
          )}
        </Column>
      </CardBody>
    </Card>
  );
}
