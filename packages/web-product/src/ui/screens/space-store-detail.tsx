'use client';

import { Suspense, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Column,
  Dialog,
  Heading,
  Icon,
  ListingAvatar,
  PageContainer,
  Row,
  Spinner,
  Text,
} from '@aflow/design-system';
import type {
  ConnectorCatalogEntry,
  McpConnectorCatalogEntry,
  SkillBundle,
  StoreInstallPreviewResponse,
  StoreInstallResponse,
  StoreUninstallPreviewResponse,
  StoreUpdateMode,
  StoreUpdatePreviewResponse,
} from '@aflow/schemas';
import {
  CODE_LANE_ABSENT_CAPABILITY_ID,
  CODE_REPO_CAPABILITY_ID,
  parseStoreInstallClaimant,
} from '@aflow/schemas';
import { AppPageHeader } from '../components/app-page-header.js';
import { MarkdownRenderer } from '../components/markdown-renderer.js';
import { SetupChecklist } from '../components/setup-checklist.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { useNavigation } from '../components/navigation-provider.js';
import { spaceRoute } from '../lib/space-routes.js';
import { listingRequirementRows } from '../lib/listing-requirements.js';
import { ApiError } from '../lib/query-client.js';
import { useApiMutation } from '../hooks/useApiQuery.js';
import { useOAuthConsentPopup } from '../lib/oauthConsentPopup.js';
import { OAUTH_CONNECTIONS_KEY } from '../hooks/use-oauth-connections.js';
import {
  listingDisplayState,
  storeErrorCode,
  storeErrorDetails,
  storeErrorDivergence,
  useStoreInstall,
  useStoreInstallPreview,
  useStoreListing,
  useStoreListings,
  useStoreUninstall,
  useStoreUninstallPreview,
  useStoreUpdate,
  useStoreUpdatePreview,
} from '../hooks/use-store.js';
import { ARTIFACT_TYPE_LABELS, titleCaseId } from '../components/store-detail/labels.js';
import { BundleInside, ConnectorInside } from '../components/store-detail/inside.js';
import {
  UpdateDialogBody,
  UpdateSuccessView,
  type UpdateFlow,
} from '../components/store-detail/update.js';
import {
  defaultKeepChoices,
  UninstallDialogBody,
  UninstallSuccessView,
  type UninstallFlow,
} from '../components/store-detail/uninstall.js';

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<'bundle' | 'connector' | 'applet', string> = {
  bundle: 'SKILL',
  connector: 'INTEGRATION',
  applet: 'APPLET',
};

function capabilityLabel(capability: string, names: ReadonlyMap<string, string>): string {
  if (capability === CODE_REPO_CAPABILITY_ID) return 'A coding repository';
  if (capability === CODE_LANE_ABSENT_CAPABILITY_ID) {
    return 'A managed coding lane, which this edition does not include';
  }
  const bare = capability.includes(':')
    ? capability.slice(capability.indexOf(':') + 1)
    : capability;
  return names.get(capability) ?? names.get(bare) ?? titleCaseId(bare);
}

const LATEST_VERSION_NOTICE = 'You already have the latest version.';

function plainErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Install flow state machine: idle → previewing → confirm → installing → done,
// with failed (retry reuses the attempt's idempotencyKey) and checkup branches.
// ---------------------------------------------------------------------------

type InstallFlow =
  | { phase: 'idle' }
  | { phase: 'previewing'; mode: 'install' | 'checkup' }
  | {
      phase: 'confirm';
      preview: StoreInstallPreviewResponse;
      idempotencyKey: string;
      notice: string | null;
    }
  | { phase: 'checkup'; preview: StoreInstallPreviewResponse }
  | { phase: 'installing'; preview: StoreInstallPreviewResponse; idempotencyKey: string }
  | {
      phase: 'failed';
      preview: StoreInstallPreviewResponse;
      idempotencyKey: string;
      message: string;
      details: string[];
    }
  | { phase: 'done'; response: StoreInstallResponse };

export function StoreListingPage() {
  return (
    <Suspense fallback={null}>
      <StoreListingPageInner />
    </Suspense>
  );
}

function StoreListingPageInner() {
  const params = useParams();
  const catalogId = String(params['catalogId']);
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  const spaceSlug = routeSpace?.slug ?? '';
  const canManage = routeSpace?.myRole === 'admin' || routeSpace?.myRole === 'editor';
  const { push } = useNavigation();

  const listingQuery = useStoreListing(spaceId, catalogId);
  const detail = listingQuery.data ?? null;
  const entry = detail?.entry ?? null;

  const memberListingsQuery = useStoreListings(entry ? spaceId : '');
  const memberByCatalogId = useMemo(() => {
    const map = new Map<string, { name: string; installed: boolean }>();
    for (const listing of memberListingsQuery.data?.listings ?? []) {
      map.set(listing.catalogId, {
        name: listing.name,
        installed: listing.installedState.installed,
      });
    }
    return map;
  }, [memberListingsQuery.data]);

  const previewMutation = useStoreInstallPreview(spaceId);
  const installMutation = useStoreInstall(spaceId);
  const updatePreviewMutation = useStoreUpdatePreview(spaceId);
  const updateMutation = useStoreUpdate(spaceId);
  const uninstallPreviewMutation = useStoreUninstallPreview(spaceId);
  const uninstallMutation = useStoreUninstall(spaceId);

  const [flow, setFlow] = useState<InstallFlow>({ phase: 'idle' });
  const [updateFlow, setUpdateFlow] = useState<UpdateFlow>({ phase: 'idle' });
  const [uninstallFlow, setUninstallFlow] = useState<UninstallFlow>({ phase: 'idle' });
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  const capabilityNames = useMemo(() => {
    const names = new Map<string, string>();
    if (!entry) return names;
    if (entry.kind === 'bundle') {
      const payload = entry.payload as SkillBundle;
      for (const d of payload.apiDefinitions) names.set(d.apiId, d.definition.name || d.apiId);
      for (const d of payload.mcpDefinitions)
        names.set(d.serverId, d.definition.name || d.serverId);
    } else if (entry.kind === 'connector' && entry.sourceKind === 'api') {
      const payload = entry.payload as ConnectorCatalogEntry;
      names.set(payload.definition.apiId, payload.name);
    } else if (entry.kind === 'connector' && entry.sourceKind === 'mcp') {
      const payload = entry.payload as McpConnectorCatalogEntry;
      names.set(payload.definition.serverId, payload.name);
    }
    return names;
  }, [entry]);
  const labelCapability = (capability: string) => capabilityLabel(capability, capabilityNames);

  const beginInstall = async () => {
    setPageNotice(null);
    setFlow({ phase: 'previewing', mode: 'install' });
    try {
      const preview = await previewMutation.mutateAsync({ catalogId });
      setFlow({ phase: 'confirm', preview, idempotencyKey: crypto.randomUUID(), notice: null });
    } catch (error) {
      setFlow({ phase: 'idle' });
      setPageNotice(plainErrorMessage(error, 'Could not check this listing.'));
    }
  };

  const checkSetup = async () => {
    setPageNotice(null);
    setFlow({ phase: 'previewing', mode: 'checkup' });
    try {
      const preview = await previewMutation.mutateAsync({ catalogId });
      setFlow({ phase: 'checkup', preview });
    } catch (error) {
      setFlow({ phase: 'idle' });
      setPageNotice(plainErrorMessage(error, 'Could not check this listing.'));
    }
  };

  const runInstall = async (preview: StoreInstallPreviewResponse, idempotencyKey: string) => {
    setFlow({ phase: 'installing', preview, idempotencyKey });
    try {
      const response = await installMutation.mutateAsync({
        catalogId,
        expectedVersion: preview.catalogVersion,
        idempotencyKey,
      });
      setFlow({ phase: 'done', response });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = storeErrorCode(error);
        if (error.status === 409 && code === 'CATALOG_CHANGED') {
          try {
            const fresh = await previewMutation.mutateAsync({ catalogId });
            setFlow({
              phase: 'confirm',
              preview: fresh,
              idempotencyKey: crypto.randomUUID(),
              notice:
                'This listing changed since you previewed it. Review the update and install again.',
            });
          } catch {
            setFlow({ phase: 'idle' });
            setPageNotice('This listing changed. Reload the page and try again.');
          }
          return;
        }
        if (error.status === 409 && code === 'ALREADY_INSTALLED') {
          setFlow({ phase: 'idle' });
          setPageNotice('Already installed — showing the current status.');
          void listingQuery.refetch();
          return;
        }
        if (error.status === 409 && code === 'STORE_MUTATION_IN_PROGRESS') {
          setFlow({
            phase: 'confirm',
            preview,
            idempotencyKey,
            notice: 'Another install is in progress in this space. Try again in a moment.',
          });
          return;
        }
        setFlow({
          phase: 'failed',
          preview,
          idempotencyKey,
          message: plainErrorMessage(error, 'Install failed.'),
          details: storeErrorDetails(error),
        });
        return;
      }
      setFlow({
        phase: 'failed',
        preview,
        idempotencyKey,
        message: plainErrorMessage(error, 'Install failed.'),
        details: [],
      });
    }
  };

  const closeFlow = () => {
    setFlow({ phase: 'idle' });
  };

  const routeUpdatePreview = (preview: StoreUpdatePreviewResponse, notice: string | null) => {
    if (!preview.updateAvailable) {
      setUpdateFlow({ phase: 'idle' });
      setPageNotice(LATEST_VERSION_NOTICE);
      void listingQuery.refetch();
      return;
    }
    setUpdateFlow({
      phase: preview.divergence.customized ? 'choose' : 'confirm',
      preview,
      idempotencyKey: crypto.randomUUID(),
      notice,
    });
  };

  const beginUpdate = async () => {
    setPageNotice(null);
    setUpdateFlow({ phase: 'previewing' });
    try {
      const preview = await updatePreviewMutation.mutateAsync({ catalogId });
      routeUpdatePreview(preview, null);
    } catch (error) {
      setUpdateFlow({ phase: 'idle' });
      setPageNotice(plainErrorMessage(error, 'Could not check for updates.'));
    }
  };

  const runUpdate = async (
    preview: StoreUpdatePreviewResponse,
    idempotencyKey: string,
    mode: StoreUpdateMode,
  ) => {
    setUpdateFlow({ phase: 'updating', preview, idempotencyKey, mode });
    try {
      const response = await updateMutation.mutateAsync({
        catalogId,
        expectedVersion: preview.catalogVersion,
        idempotencyKey,
        mode,
      });
      if (response.mode === 'keep') {
        setUpdateFlow({ phase: 'idle' });
        setPageNotice(
          'Kept your version. The update badge will come back when the next version arrives.',
        );
        return;
      }
      setUpdateFlow({ phase: 'done', response });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = storeErrorCode(error);
        if (error.status === 409 && code === 'CATALOG_CHANGED') {
          try {
            const fresh = await updatePreviewMutation.mutateAsync({ catalogId });
            routeUpdatePreview(
              fresh,
              'This listing changed since you previewed it. Review again and continue.',
            );
          } catch {
            setUpdateFlow({ phase: 'idle' });
            setPageNotice('This listing changed. Reload the page and try again.');
          }
          return;
        }
        if (error.status === 409 && code === 'STORE_CUSTOMIZED') {
          const divergence = storeErrorDivergence(error);
          setUpdateFlow({
            phase: 'choose',
            preview: divergence ? { ...preview, divergence } : preview,
            idempotencyKey,
            notice: 'You have changed this since installing — choose what to do with your changes.',
          });
          return;
        }
        if (error.status === 409 && code === 'ALREADY_CURRENT') {
          setUpdateFlow({ phase: 'idle' });
          setPageNotice(LATEST_VERSION_NOTICE);
          void listingQuery.refetch();
          return;
        }
        if (error.status === 404 && code === 'NOT_INSTALLED') {
          setUpdateFlow({ phase: 'idle' });
          setPageNotice('This is no longer installed in this space.');
          void listingQuery.refetch();
          return;
        }
        if (
          error.status === 409 &&
          (code === 'STORE_MUTATION_IN_PROGRESS' || code === 'REMOVAL_IN_PROGRESS')
        ) {
          setUpdateFlow({
            phase: preview.divergence.customized ? 'choose' : 'confirm',
            preview,
            idempotencyKey,
            notice: 'Another change is in progress in this space. Try again in a moment.',
          });
          return;
        }
        setUpdateFlow({
          phase: 'failed',
          preview,
          idempotencyKey,
          mode,
          message: plainErrorMessage(error, 'Update failed.'),
          details: storeErrorDetails(error),
        });
        return;
      }
      setUpdateFlow({
        phase: 'failed',
        preview,
        idempotencyKey,
        mode,
        message: plainErrorMessage(error, 'Update failed.'),
        details: [],
      });
    }
  };

  const closeUpdateFlow = () => {
    setUpdateFlow({ phase: 'idle' });
  };

  const beginUninstall = async () => {
    setPageNotice(null);
    setUninstallFlow({ phase: 'previewing' });
    try {
      const preview = await uninstallPreviewMutation.mutateAsync({ catalogId });
      setUninstallFlow({
        phase: 'confirm',
        preview,
        idempotencyKey: crypto.randomUUID(),
        keep: defaultKeepChoices(preview),
        notice: null,
      });
    } catch (error) {
      setUninstallFlow({ phase: 'idle' });
      setPageNotice(plainErrorMessage(error, 'Could not check this listing.'));
    }
  };

  const toggleKeep = (artifactKey: string, value: boolean) => {
    setUninstallFlow((current) =>
      current.phase === 'confirm'
        ? { ...current, keep: { ...current.keep, [artifactKey]: value } }
        : current,
    );
  };

  const runUninstall = async (
    preview: StoreUninstallPreviewResponse,
    idempotencyKey: string,
    keep: Record<string, boolean>,
  ) => {
    setUninstallFlow({ phase: 'removing', preview, idempotencyKey, keep });
    const keepableKeys = Object.keys(keep);
    try {
      const response = await uninstallMutation.mutateAsync({
        catalogId,
        idempotencyKey,
        ...(keepableKeys.length > 0
          ? { keepUserData: keepableKeys.filter((key) => keep[key]) }
          : {}),
      });
      setUninstallFlow({ phase: 'done', response });
    } catch (error) {
      if (error instanceof ApiError) {
        const code = storeErrorCode(error);
        if (error.status === 404 && code === 'NOT_INSTALLED') {
          setUninstallFlow({ phase: 'idle' });
          setPageNotice('This is no longer installed in this space.');
          void listingQuery.refetch();
          return;
        }
        if (error.status === 409 && code === 'STORE_MUTATION_IN_PROGRESS') {
          setUninstallFlow({
            phase: 'confirm',
            preview,
            idempotencyKey,
            keep,
            notice: 'Another change is in progress in this space. Try again in a moment.',
          });
          return;
        }
        if (error.status === 409 && code === 'SKILL_HAS_ACTIVE_RUNS') {
          setUninstallFlow({
            phase: 'failed',
            preview,
            idempotencyKey,
            keep,
            message: 'A skill in this listing is still running. Stop its runs, then try again.',
          });
          return;
        }
      }
      setUninstallFlow({
        phase: 'failed',
        preview,
        idempotencyKey,
        keep,
        message: plainErrorMessage(error, 'Uninstall failed.'),
      });
    }
  };

  const closeUninstallFlow = () => {
    setUninstallFlow({ phase: 'idle' });
  };

  if (!routeSpace || listingQuery.isLoading) {
    return (
      <>
        <AppPageHeader title="Store" />
        <PageContainer>
          <Row justify="center" style={{ padding: 'var(--space-6)' }}>
            <Spinner size="lg" label="Loading listing" />
          </Row>
        </PageContainer>
      </>
    );
  }

  if (!detail || !entry) {
    return (
      <>
        <AppPageHeader title="Store" />
        <PageContainer>
          <Column gap="md" align="center" style={{ padding: 'var(--space-6)' }}>
            <Icon name="warning" size="lg" />
            <Text size="sm">This listing is not available.</Text>
            <Button
              variant="secondary"
              onClick={() => {
                push(spaceRoute(spaceSlug, '/store'));
              }}
            >
              Back to Store
            </Button>
          </Column>
        </PageContainer>
      </>
    );
  }

  const display = listingDisplayState(detail.installedState);
  const bundlePayload = entry.kind === 'bundle' ? (entry.payload as SkillBundle) : null;
  const apiConnectorPayload =
    entry.kind === 'connector' && entry.sourceKind === 'api'
      ? (entry.payload as ConnectorCatalogEntry)
      : null;
  const mcpConnectorPayload =
    entry.kind === 'connector' && entry.sourceKind === 'mcp'
      ? (entry.payload as McpConnectorCatalogEntry)
      : null;

  const openPath = entry.kind === 'connector' ? '/integrations' : '/skills';

  const requirements = listingRequirementRows(detail.requirements);
  const busy = flow.phase === 'previewing' || flow.phase === 'installing';
  const updateBusy = updateFlow.phase === 'previewing' || updateFlow.phase === 'updating';
  const uninstallBusy = uninstallFlow.phase === 'previewing' || uninstallFlow.phase === 'removing';

  const artifactName = (artifactKey: string): string => {
    const known = capabilityNames.get(artifactKey);
    if (known) return known;
    return titleCaseId(artifactKey);
  };

  const claimLabel = (claimant: string): string => {
    const parsed = parseStoreInstallClaimant(claimant);
    if (parsed?.kind === 'bundle') {
      return (
        memberByCatalogId.get(parsed.bundleCatalogId)?.name ?? titleCaseId(parsed.bundleCatalogId)
      );
    }
    return 'your direct install';
  };

  return (
    <>
      <AppPageHeader title="Store" />
      <PageContainer>
        <Column gap="lg" style={{ maxWidth: 860 }}>
          <Row gap="sm" align="center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                push(spaceRoute(spaceSlug, '/store'));
              }}
            >
              <Icon name="arrow-left" size="sm" /> Store
            </Button>
          </Row>

          {/* Hero */}
          <Row gap="md" align="start">
            <ListingAvatar
              {...(entry.icon ? { icon: entry.icon } : {})}
              name={entry.name}
              kind={entry.kind}
              seed={entry.catalogId}
              size="xl"
            />
            <Column gap="xs" style={{ minWidth: 0, flex: 1 }}>
              <Row gap="sm" align="center" wrap>
                <Heading level={3}>{entry.name}</Heading>
                <Badge variant="neutral">{KIND_LABELS[entry.kind]}</Badge>
                {display === 'installed' && <Badge variant="success">Installed</Badge>}
                {display === 'update_available' && <Badge variant="info">Update available</Badge>}
              </Row>
              <Row gap="xs" align="center" wrap>
                {entry.vendor && (
                  <Text size="xs" variant="muted">
                    {entry.vendor}
                  </Text>
                )}
                <Badge variant="neutral">v{String(entry.version)}</Badge>
                <Badge variant={entry.honestyLabel === 'curated' ? 'accent' : 'info'}>
                  {entry.honestyLabel === 'curated' ? 'Curated by Aflow' : 'Generated, validated'}
                </Badge>
              </Row>
              <Text size="sm" variant="muted">
                {entry.tagline}
              </Text>
              {entry.tags.length > 0 && (
                <Row gap="xs" wrap>
                  {entry.tags.map((tag) => (
                    <Badge key={tag} variant="neutral">
                      {tag}
                    </Badge>
                  ))}
                </Row>
              )}
            </Column>
          </Row>

          {pageNotice && (
            <Card>
              <CardBody>
                <Row gap="sm" align="center">
                  <Icon name="info" size="sm" />
                  <Text size="sm">{pageNotice}</Text>
                </Row>
              </CardBody>
            </Card>
          )}

          {/* Primary action */}
          {flow.phase !== 'done' &&
            updateFlow.phase !== 'done' &&
            uninstallFlow.phase !== 'done' && (
              <Row gap="sm" align="center" wrap>
                {display === 'not_installed' && canManage && entry.status !== 'deprecated' && (
                  <Button variant="primary" loading={busy} onClick={() => void beginInstall()}>
                    Install
                  </Button>
                )}
                {display === 'not_installed' && entry.status === 'deprecated' && (
                  <Text size="sm" variant="muted">
                    This listing is no longer available to install.
                  </Text>
                )}
                {display !== 'not_installed' && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      push(spaceRoute(spaceSlug, openPath));
                    }}
                  >
                    Open
                  </Button>
                )}
                {display === 'installed' && canManage && (
                  <Button variant="secondary" loading={busy} onClick={() => void checkSetup()}>
                    Check setup again
                  </Button>
                )}
                {display === 'update_available' && canManage && (
                  <Button
                    variant="secondary"
                    loading={updateBusy}
                    onClick={() => void beginUpdate()}
                  >
                    Update
                  </Button>
                )}
                {display !== 'not_installed' && canManage && (
                  <Button
                    variant="ghost"
                    loading={uninstallBusy}
                    onClick={() => void beginUninstall()}
                  >
                    Uninstall
                  </Button>
                )}
              </Row>
            )}

          {flow.phase === 'done' && (
            <InstallSuccessView
              response={flow.response}
              spaceId={spaceId}
              spaceSlug={spaceSlug}
              openPath={openPath}
              onNavigate={push}
            />
          )}

          {updateFlow.phase === 'done' && (
            <UpdateSuccessView
              response={updateFlow.response}
              spaceSlug={spaceSlug}
              openPath={openPath}
              onNavigate={push}
              artifactName={artifactName}
            />
          )}

          {uninstallFlow.phase === 'done' && (
            <UninstallSuccessView
              response={uninstallFlow.response}
              entryName={entry.name}
              spaceSlug={spaceSlug}
              onNavigate={push}
              artifactName={artifactName}
              claimLabel={claimLabel}
            />
          )}

          {/* Description */}
          <MarkdownRenderer content={entry.description} />

          {/* What's inside */}
          <Column gap="sm">
            <Heading level={5}>What&rsquo;s inside</Heading>
            {bundlePayload && (
              <BundleInside payload={bundlePayload} memberByCatalogId={memberByCatalogId} />
            )}
            {(apiConnectorPayload || mcpConnectorPayload) && (
              <ConnectorInside
                hosts={
                  mcpConnectorPayload ? entry.hostManifest.mcpHosts : entry.hostManifest.apiHosts
                }
                endpointCount={apiConnectorPayload?.definition.endpoints.length ?? null}
              />
            )}
          </Column>

          {/* What you'll need */}
          <Column gap="sm">
            <Heading level={5}>What you&rsquo;ll need</Heading>
            {requirements.length === 0 ? (
              <Row gap="sm" align="center">
                <Icon name="check-circle" size="sm" />
                <Text size="sm" variant="muted">
                  Nothing — this is ready right after install.
                </Text>
              </Row>
            ) : (
              <Column gap="xs">
                {requirements.map((row) => (
                  <Row key={row.label} gap="sm" align="center">
                    <Icon name={row.icon} size="sm" />
                    <Text size="sm">{row.label}</Text>
                  </Row>
                ))}
              </Column>
            )}
          </Column>
        </Column>
      </PageContainer>

      {/* Install confirm dialog */}
      <Dialog
        open={flow.phase === 'confirm' || flow.phase === 'installing' || flow.phase === 'failed'}
        onClose={closeFlow}
        title={`Install ${entry.name}`}
        footer={
          flow.phase === 'confirm' || flow.phase === 'installing' || flow.phase === 'failed' ? (
            <Row gap="sm" justify="end">
              <Button variant="ghost" onClick={closeFlow} disabled={flow.phase === 'installing'}>
                Cancel
              </Button>
              {flow.phase === 'failed' ? (
                <Button
                  variant="primary"
                  onClick={() => void runInstall(flow.preview, flow.idempotencyKey)}
                >
                  Try again
                </Button>
              ) : (
                <Button
                  variant="primary"
                  loading={flow.phase === 'installing'}
                  disabled={flow.phase !== 'installing' && flow.preview.conflicts.length > 0}
                  onClick={() => {
                    if (flow.phase === 'confirm')
                      void runInstall(flow.preview, flow.idempotencyKey);
                  }}
                >
                  Install
                </Button>
              )}
            </Row>
          ) : undefined
        }
      >
        {(flow.phase === 'confirm' || flow.phase === 'installing' || flow.phase === 'failed') && (
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
                  <Column gap="xs">
                    <Row gap="sm" align="center">
                      <Icon name="warning" size="sm" />
                      <Text size="sm" weight="medium">
                        Install failed
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

            {flow.preview.creates.length > 0 && (
              <Column gap="xs">
                <Text size="sm" weight="medium">
                  This will add
                </Text>
                {flow.preview.creates.map((artifact) => (
                  <Row
                    key={`${artifact.artifactType}:${artifact.artifactKey}`}
                    gap="sm"
                    align="center"
                  >
                    <Icon name="plus" size="xs" />
                    <Badge variant="neutral">{ARTIFACT_TYPE_LABELS[artifact.artifactType]}</Badge>
                    <Text size="xs" truncate>
                      {artifact.name ?? artifact.artifactKey}
                    </Text>
                  </Row>
                ))}
              </Column>
            )}

            {flow.preview.conflicts.length > 0 && (
              <Column gap="xs">
                <Text size="sm" weight="medium">
                  Already in this space
                </Text>
                {flow.preview.conflicts.map((conflict, i) => (
                  <Row key={i} gap="xs" align="start">
                    <Icon name="warning" size="xs" />
                    <Text size="xs">{conflict.reason}</Text>
                  </Row>
                ))}
                <Text size="xs" variant="muted">
                  Resolve these first, then try again.
                </Text>
              </Column>
            )}

            {flow.preview.missingCapabilities.length > 0 && (
              <Column gap="xs">
                <Text size="sm" weight="medium">
                  Needs setup after install
                </Text>
                {flow.preview.missingCapabilities.map((capability) => (
                  <Row key={capability} gap="sm" align="center">
                    <Icon name="plugs" size="xs" />
                    <Text size="xs">{labelCapability(capability)}</Text>
                  </Row>
                ))}
              </Column>
            )}
          </Column>
        )}
      </Dialog>

      {/* Setup checkup dialog */}
      <Dialog
        open={flow.phase === 'checkup'}
        onClose={closeFlow}
        title="Setup check"
        footer={
          <Row gap="sm" justify="end">
            <Button variant="secondary" onClick={closeFlow}>
              Close
            </Button>
          </Row>
        }
      >
        {flow.phase === 'checkup' && (
          <Column gap="md">
            {flow.preview.missingCapabilities.length === 0 ? (
              <Row gap="sm" align="center">
                <Icon name="check-circle" size="sm" />
                <Text size="sm">Everything this needs is set up in this space.</Text>
              </Row>
            ) : (
              <Column gap="xs">
                <Text size="sm" weight="medium">
                  Still needs setup
                </Text>
                {flow.preview.missingCapabilities.map((capability) => (
                  <Row key={capability} gap="sm" align="center">
                    <Icon name="plugs" size="xs" />
                    <Text size="xs">{labelCapability(capability)}</Text>
                  </Row>
                ))}
                {flow.preview.missingCapabilities.some(
                  (capability) => capability !== CODE_LANE_ABSENT_CAPABILITY_ID,
                ) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      push(spaceRoute(spaceSlug, '/integrations'));
                    }}
                  >
                    Open Integrations
                  </Button>
                ) : (
                  <Text size="xs" variant="muted">
                    Not available in this edition; no setup in this space can supply it.
                  </Text>
                )}
              </Column>
            )}
          </Column>
        )}
      </Dialog>

      {/* Update dialog — confirm (pristine) or choose (customized) */}
      <Dialog
        open={
          updateFlow.phase === 'confirm' ||
          updateFlow.phase === 'choose' ||
          updateFlow.phase === 'updating' ||
          updateFlow.phase === 'failed'
        }
        onClose={closeUpdateFlow}
        title={`Update ${entry.name}`}
        footer={
          updateFlow.phase === 'failed' ? (
            <Row gap="sm" justify="end">
              <Button variant="ghost" onClick={closeUpdateFlow}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() =>
                  void runUpdate(updateFlow.preview, updateFlow.idempotencyKey, updateFlow.mode)
                }
              >
                Try again
              </Button>
            </Row>
          ) : updateFlow.phase === 'confirm' ||
            (updateFlow.phase === 'updating' && updateFlow.mode === 'update') ? (
            <Row gap="sm" justify="end">
              <Button
                variant="ghost"
                onClick={closeUpdateFlow}
                disabled={updateFlow.phase === 'updating'}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={updateFlow.phase === 'updating'}
                onClick={() => {
                  if (updateFlow.phase === 'confirm')
                    void runUpdate(updateFlow.preview, updateFlow.idempotencyKey, 'update');
                }}
              >
                Update
              </Button>
            </Row>
          ) : updateFlow.phase === 'choose' || updateFlow.phase === 'updating' ? (
            <Row gap="sm" justify="end">
              <Button
                variant="ghost"
                onClick={closeUpdateFlow}
                disabled={updateFlow.phase === 'updating'}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                loading={updateFlow.phase === 'updating' && updateFlow.mode === 'keep'}
                disabled={updateFlow.phase === 'updating' && updateFlow.mode !== 'keep'}
                onClick={() => {
                  if (updateFlow.phase === 'choose')
                    void runUpdate(updateFlow.preview, updateFlow.idempotencyKey, 'keep');
                }}
              >
                Keep mine
              </Button>
              <Button
                variant="danger"
                loading={
                  updateFlow.phase === 'updating' && updateFlow.mode === 'replace_customized'
                }
                disabled={
                  updateFlow.phase === 'updating' && updateFlow.mode !== 'replace_customized'
                }
                onClick={() => {
                  if (updateFlow.phase === 'choose')
                    void runUpdate(
                      updateFlow.preview,
                      updateFlow.idempotencyKey,
                      'replace_customized',
                    );
                }}
              >
                Replace with Store version
              </Button>
            </Row>
          ) : undefined
        }
      >
        {(updateFlow.phase === 'confirm' ||
          updateFlow.phase === 'choose' ||
          updateFlow.phase === 'updating' ||
          updateFlow.phase === 'failed') && (
          <UpdateDialogBody flow={updateFlow} entryName={entry.name} artifactName={artifactName} />
        )}
      </Dialog>

      {/* Uninstall confirm dialog — the blast radius */}
      <Dialog
        open={
          uninstallFlow.phase === 'confirm' ||
          uninstallFlow.phase === 'removing' ||
          uninstallFlow.phase === 'failed'
        }
        onClose={closeUninstallFlow}
        title={`Uninstall ${entry.name}`}
        footer={
          uninstallFlow.phase === 'confirm' ||
          uninstallFlow.phase === 'removing' ||
          uninstallFlow.phase === 'failed' ? (
            <Row gap="sm" justify="end">
              <Button
                variant="ghost"
                onClick={closeUninstallFlow}
                disabled={uninstallFlow.phase === 'removing'}
              >
                Cancel
              </Button>
              {uninstallFlow.phase === 'failed' ? (
                <Button
                  variant="danger"
                  onClick={() =>
                    void runUninstall(
                      uninstallFlow.preview,
                      uninstallFlow.idempotencyKey,
                      uninstallFlow.keep,
                    )
                  }
                >
                  Try again
                </Button>
              ) : (
                <Button
                  variant="danger"
                  loading={uninstallFlow.phase === 'removing'}
                  disabled={
                    uninstallFlow.phase === 'confirm' &&
                    uninstallFlow.preview.artifacts.some(
                      (artifact) => (artifact.activeRunCount ?? 0) > 0,
                    )
                  }
                  onClick={() => {
                    if (uninstallFlow.phase === 'confirm')
                      void runUninstall(
                        uninstallFlow.preview,
                        uninstallFlow.idempotencyKey,
                        uninstallFlow.keep,
                      );
                  }}
                >
                  {uninstallFlow.preview.action === 'release_claim' ? 'Remove' : 'Uninstall'}
                </Button>
              )}
            </Row>
          ) : undefined
        }
      >
        {(uninstallFlow.phase === 'confirm' ||
          uninstallFlow.phase === 'removing' ||
          uninstallFlow.phase === 'failed') && (
          <UninstallDialogBody
            flow={uninstallFlow}
            entryName={entry.name}
            artifactName={artifactName}
            claimLabel={claimLabel}
            memberName={(memberCatalogId) =>
              memberByCatalogId.get(memberCatalogId)?.name ?? titleCaseId(memberCatalogId)
            }
            onToggleKeep={toggleKeep}
          />
        )}
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Success view — the setup checklist
// ---------------------------------------------------------------------------

function InstallSuccessView({
  response,
  spaceId,
  spaceSlug,
  openPath,
  onNavigate,
}: {
  response: StoreInstallResponse;
  spaceId: string;
  spaceSlug: string;
  openPath: string;
  onNavigate: (path: string) => void;
}) {
  const { result, setupChecklist } = response;
  const needsAccountConnect =
    result.kind === 'connector' && result.status === 'needs_oauth_consent';
  const consentPath = result.kind === 'connector' ? result.consentPath : undefined;
  const allDone = setupChecklist.length === 0 && !needsAccountConnect;

  const queryClient = useQueryClient();
  const { launch } = useOAuthConsentPopup();
  const [consentError, setConsentError] = useState<string | null>(null);
  const startConsent = useApiMutation<undefined, { authorizationUrl?: string }>({
    path: consentPath ?? '',
    method: 'POST',
  });

  const handleConnect = () => {
    if (!consentPath) {
      onNavigate(spaceRoute(spaceSlug, '/integrations'));
      return;
    }
    setConsentError(null);
    launch({
      start: () => startConsent.mutateAsync(undefined),
      onClosed: () => {
        void queryClient.invalidateQueries({ queryKey: [...OAUTH_CONNECTIONS_KEY] });
        void queryClient.invalidateQueries({ queryKey: ['space', spaceId, 'integrations'] });
      },
      onError: (message) => {
        setConsentError(message);
      },
    });
  };

  return (
    <Card>
      <CardBody>
        <Column gap="md">
          <Row gap="sm" align="center">
            <Icon name="check-circle" size="sm" />
            <Text size="sm" weight="medium">
              Installed
            </Text>
          </Row>

          {setupChecklist.length > 0 && (
            <Column gap="sm">
              <Text size="sm" weight="medium">
                Setup checklist
              </Text>
              <SetupChecklist
                tasks={setupChecklist}
                spaceSlug={spaceSlug}
                onNavigate={onNavigate}
              />
            </Column>
          )}

          {needsAccountConnect && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Connect your account
              </Text>
              <Text size="xs" variant="muted">
                Sign in with the provider to finish setting this up.
              </Text>
              <Row>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleConnect}
                  disabled={startConsent.isPending}
                >
                  {startConsent.isPending ? 'Connecting…' : 'Connect your account'}
                </Button>
              </Row>
              {consentError && (
                <Text size="xs" tone="danger">
                  {consentError}
                </Text>
              )}
            </Column>
          )}

          {allDone && (
            <Row gap="sm" align="center">
              <Icon name="check-circle" size="sm" />
              <Text size="xs" variant="muted">
                Every required connection and setup step is configured.
              </Text>
            </Row>
          )}

          {result.kind === 'bundle' && result.warnings.length > 0 && (
            <Column gap="xs">
              <Text size="sm" weight="medium">
                Warnings
              </Text>
              {result.warnings.map((warning, i) => (
                <Row key={i} gap="xs" align="start">
                  <Icon name="warning" size="xs" />
                  <Text size="xs" variant="muted">
                    {warning}
                  </Text>
                </Row>
              ))}
            </Column>
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
