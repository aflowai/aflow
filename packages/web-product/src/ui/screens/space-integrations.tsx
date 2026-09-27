'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AppPageHeader } from '../components/app-page-header.js';
import { Button, Column, EmptyState, Icon, PageContainer, Row, Text } from '@aflow/design-system';
import { useIntegrations } from '../hooks/use-integrations.js';
import type { ApiBindingSummary, ApiDefinitionDetail } from '../hooks/use-integrations.js';
import { useSpaceFromRoute } from '../components/providers.js';
import { spaceRoute } from '../lib/space-routes.js';
import { ApiCard } from '../components/integrations-api/ApiCard.js';
import { ApiConnectApiDialog } from '../components/integrations-api/ApiConnectApiDialog.js';
import { ApiCredentialDialog } from '../components/integrations-api/ApiCredentialDialog.js';
import { ApiDefinitionFormDialog } from '../components/integrations-api/ApiDefinitionFormDialog.js';
import { SimulationPanel } from '../components/integrations-api/SimulationPanel.js';
import {
  AddIntegrationButton,
  FilterChips,
  KindBadge,
  type Filter,
  type IntegrationKind,
} from '../components/integrations/IntegrationsHeader.js';
import { useMcpIntegrations } from '../components/integrations-mcp/use-mcp-integrations.js';
import type { McpServerDefinitionSummary } from '../components/integrations-mcp/use-mcp-integrations.js';
import { McpIntegrationCard } from '../components/integrations-mcp/McpIntegrationCard.js';
import { McpIntegrationFormDialog } from '../components/integrations-mcp/McpIntegrationFormDialog.js';
import {
  McpConfirmDeleteDialog,
  useDeleteAction,
} from '../components/integrations-mcp/McpConfirmDeleteDialog.js';
import { useRepoBindings } from '../hooks/use-repo-bindings.js';
import type { RepoBindingSummary } from '../hooks/use-repo-bindings.js';
import { RepoBindingCard } from '../components/integrations-repo/RepoBindingCard.js';
import { RepoBindingFormDialog } from '../components/integrations-repo/RepoBindingFormDialog.js';

type UnifiedItem =
  | { kind: 'api'; def: ReturnType<typeof useIntegrations>['definitions'][number] }
  | { kind: 'mcp'; def: McpServerDefinitionSummary }
  | { kind: 'repo'; def: RepoBindingSummary };

/** Sort/display name per item — repos are identified by their coordinate, not a name. */
function unifiedName(item: UnifiedItem): string {
  return item.kind === 'repo' ? item.def.coordinate : item.def.name;
}

export function SpaceIntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsPageInner />
    </Suspense>
  );
}

function IntegrationsPageInner() {
  const routeSpace = useSpaceFromRoute();
  const spaceId = routeSpace?.id ?? '';
  // Server truth: definition/binding/repo writes need api_config:write
  // (admin/editor); viewers get 403s, so don't render the affordances.
  const canManage = routeSpace?.myRole === 'admin' || routeSpace?.myRole === 'editor';
  const api = useIntegrations(spaceId);
  const mcp = useMcpIntegrations();
  const repo = useRepoBindings(spaceId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [filter, setFilter] = useState<Filter>('all');
  const [showAddApi, setShowAddApi] = useState(false);

  // API dialog state
  const [connectDialog, setConnectDialog] = useState<{
    apiId: string;
    editBinding?: ApiBindingSummary;
  } | null>(null);
  const [credDialog, setCredDialog] = useState<{
    credentialKey: string;
    label: string;
    existing: boolean;
  } | null>(null);
  // Edit-definition dialog state — when set, we've loaded the full detail
  // (endpoints included) and the dialog can prefill all fields.
  const [editApiDefinition, setEditApiDefinition] = useState<ApiDefinitionDetail | null>(null);

  // MCP dialog state — `null` = closed. `{ definition: undefined }` = add. `{ definition: X }` = edit.
  const [mcpFormTarget, setMcpFormTarget] = useState<{
    definition?: McpServerDefinitionSummary;
  } | null>(null);
  const [mcpDeleteTarget, setMcpDeleteTarget] = useState<McpServerDefinitionSummary | null>(null);
  const closeMcpDelete = () => {
    setMcpDeleteTarget(null);
  };
  const { isDeleting, run: runMcpDelete } = useDeleteAction(closeMcpDelete);

  // Repo binding dialog state — `null` = closed, `{}` = add, `{ binding }` = edit.
  const [repoFormTarget, setRepoFormTarget] = useState<{ binding?: RepoBindingSummary } | null>(
    null,
  );
  const [repoArchiveTarget, setRepoArchiveTarget] = useState<RepoBindingSummary | null>(null);
  const closeRepoArchive = () => {
    setRepoArchiveTarget(null);
  };
  const { isDeleting: isArchivingRepo, run: runRepoArchive } = useDeleteAction(closeRepoArchive);

  // Per-connection delete — a doomed github connection that still backs repos is
  // blocked server-side (fail-closed); the confirm copy warns about them up front.
  const [bindingDeleteTarget, setBindingDeleteTarget] = useState<ApiBindingSummary | null>(null);
  const closeBindingDelete = () => {
    setBindingDeleteTarget(null);
  };
  const { isDeleting: isDeletingBinding, run: runBindingDelete } =
    useDeleteAction(closeBindingDelete);

  const handlePickAdd = (kind: IntegrationKind) => {
    if (kind === 'api') setShowAddApi(true);
    else if (kind === 'mcp') setMcpFormTarget({});
    else setRepoFormTarget({});
  };

  const credentialsByKey = useMemo(
    () => new Map(api.credentials.map((c) => [c.credentialKey, c])),
    [api.credentials],
  );
  // Every binding grouped under its API definition — a provider can host more
  // than one connection (e.g. two GitHub accounts).
  const bindingsByApiId = useMemo(() => {
    const m = new Map<string, ApiBindingSummary[]>();
    for (const b of api.bindings) {
      const l = m.get(b.apiId) ?? [];
      l.push(b);
      m.set(b.apiId, l);
    }
    return m;
  }, [api.bindings]);

  // Every github api binding (incl. disabled) keyed by bindingId — the single
  // source the repo cards mirror git-credential resolution against, and from
  // which the enabled-only connect options are derived.
  const githubConnectionsById = useMemo(
    () => new Map(api.bindings.filter((b) => b.apiId === 'github').map((b) => [b.bindingId, b])),
    [api.bindings],
  );
  const githubConnections = useMemo(
    () =>
      [...githubConnectionsById.values()]
        .filter((b) => b.enabled)
        .map((b) => ({ bindingId: b.bindingId, name: b.name })),
    [githubConnectionsById],
  );

  const apiDefinitionByApiId = useMemo(
    () => new Map(api.definitions.map((d) => [d.apiId, d])),
    [api.definitions],
  );

  // `?add=repo` deep-link (e.g. from the Store) opens the add-repo dialog.
  // Strip the param off the current path so closing the dialog doesn't re-open it.
  // Replace via `pathname` (always present) rather than a reconstructed space route —
  // the resolved space is null during the spaces-data load window, which would strip
  // to a bare `/integrations` and bounce a cold-loaded link out of its space.
  useEffect(() => {
    if (searchParams.get('add') === 'repo') {
      setRepoFormTarget({});
      router.replace(pathname);
    }
  }, [searchParams, router, pathname]);

  // `?configure=<bindingId>` / `?test=<bindingId>` deep-links (the Store's
  // setup checklist) open the matching connect/edit dialog once bindings have
  // loaded, then clear the param the same way `?add=repo` does.
  useEffect(() => {
    const bindingId = searchParams.get('configure') ?? searchParams.get('test');
    if (!bindingId) return;
    if (api.isLoading || mcp.isLoading) return;
    const apiBinding = api.bindings.find((b) => b.bindingId === bindingId);
    if (apiBinding) {
      setConnectDialog({ apiId: apiBinding.apiId, editBinding: apiBinding });
    } else {
      const mcpBinding = mcp.bindings.find((b) => b.bindingId === bindingId);
      const definition = mcpBinding
        ? mcp.definitions.find((d) => d.serverId === mcpBinding.serverId)
        : undefined;
      if (definition) setMcpFormTarget({ definition });
    }
    router.replace(pathname);
  }, [
    searchParams,
    api.isLoading,
    api.bindings,
    mcp.isLoading,
    mcp.bindings,
    mcp.definitions,
    router,
    pathname,
  ]);

  const firstMcpBindingByServerId = useMemo(() => {
    const m = new Map<string, (typeof mcp.bindings)[number]>();
    for (const b of mcp.bindings) {
      if (!m.has(b.serverId)) m.set(b.serverId, b);
    }
    return m;
  }, [mcp.bindings]);

  const mcpCredentialsByKey = useMemo(
    () => new Map(mcp.credentials.map((c) => [c.credentialKey, c])),
    [mcp.credentials],
  );

  // Repos that nest under a github connection: linked to a known github
  // connection AND a github definition exists to render that card (an orphaned
  // binding must not make its repos vanish from the flat list). Grouped by the
  // connection they resolve through so each connection hosts its own repos.
  const githubReposByConnectionId = useMemo(() => {
    const m = new Map<string, RepoBindingSummary[]>();
    const hasGithubDef = api.definitions.some((d) => d.apiId === 'github');
    if (!hasGithubDef) return m;
    for (const r of repo.repoBindings) {
      if (!githubConnectionsById.has(r.connectionBindingId)) continue;
      const l = m.get(r.connectionBindingId) ?? [];
      l.push(r);
      m.set(r.connectionBindingId, l);
    }
    return m;
  }, [repo.repoBindings, githubConnectionsById, api.definitions]);
  const nestSetIds = useMemo(() => {
    const s = new Set<string>();
    for (const repos of githubReposByConnectionId.values()) {
      for (const r of repos) s.add(r.repoDesignationId);
    }
    return s;
  }, [githubReposByConnectionId]);

  // Repos resolving git through a shared connection token (no per-repo override)
  // counted per connection — drives the fan-out nudge.
  const sharedConnectionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of repo.repoBindings) {
      if (b.credentialKey) continue;
      m.set(b.connectionBindingId, (m.get(b.connectionBindingId) ?? 0) + 1);
    }
    return m;
  }, [repo.repoBindings]);

  const items = useMemo<UnifiedItem[]>(() => {
    const all: UnifiedItem[] = [
      ...api.definitions.map<UnifiedItem>((def) => ({ kind: 'api', def })),
      ...mcp.definitions.map<UnifiedItem>((def) => ({ kind: 'mcp', def })),
      ...repo.repoBindings.map<UnifiedItem>((def) => ({ kind: 'repo', def })),
    ];
    all.sort((a, b) => unifiedName(a).toLowerCase().localeCompare(unifiedName(b).toLowerCase()));
    if (filter === 'all') {
      return all.filter((i) => i.kind !== 'repo' || !nestSetIds.has(i.def.repoDesignationId));
    }
    return all.filter((i) => i.kind === filter);
  }, [api.definitions, mcp.definitions, repo.repoBindings, filter, nestSetIds]);

  const totalCount = api.definitions.length + mcp.definitions.length + repo.repoBindings.length;
  const isLoading = api.isLoading || mcp.isLoading || repo.isLoading;
  const combinedError = api.error ?? mcp.error ?? repo.error;

  if (isLoading && totalCount === 0) {
    return (
      <>
        <AppPageHeader title="Integrations" />
        <PageContainer>{null}</PageContainer>
      </>
    );
  }

  if (combinedError) {
    return (
      <>
        <AppPageHeader title="Integrations" />
        <PageContainer>
          <EmptyState
            icon={<Icon name="warning-circle" size={48} weight="thin" />}
            title="Failed to load integrations"
            description={combinedError}
          />
        </PageContainer>
      </>
    );
  }

  const renderRepoCard = (r: RepoBindingSummary, nested: boolean) => (
    <RepoBindingCard
      key={`repo:${r.repoDesignationId}`}
      binding={r}
      credentialsByKey={credentialsByKey}
      connectionsById={githubConnectionsById}
      kindBadge={<KindBadge kind="repo" />}
      nested={nested}
      sharedRepoCount={
        r.credentialKey ? 0 : (sharedConnectionCounts.get(r.connectionBindingId) ?? 0)
      }
      readOnly={!canManage}
      onEdit={() => {
        setRepoFormTarget({ binding: r });
      }}
      onArchive={() => {
        setRepoArchiveTarget(r);
      }}
    />
  );

  return (
    <>
      <AppPageHeader title="Integrations" />
      <PageContainer>
        <Column gap="3">
          <Row
            justify="between"
            align="center"
            wrap
            gap="2"
            style={{ marginBottom: 'var(--space-2xl)' }}
          >
            <Text size="sm" variant="muted" style={{ flex: '1 1 260px', minWidth: 0 }}>
              Connect external APIs, MCP servers, and code repositories your agents can discover,
              promote, and call.
            </Text>
            <Row gap="2" align="center" wrap>
              <FilterChips value={filter} onChange={setFilter} />
              {canManage && (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      router.push(spaceRoute(routeSpace?.slug, '/store?kind=integration'));
                    }}
                  >
                    Browse integrations
                  </Button>
                  <AddIntegrationButton onPick={handlePickAdd} />
                </>
              )}
            </Row>
          </Row>

          {items.length === 0 ? (
            <EmptyState
              icon={<Icon name="plugs-connected" size={48} weight="thin" />}
              title={totalCount === 0 ? 'No integrations yet' : 'No integrations match this filter'}
              description={
                totalCount === 0
                  ? canManage
                    ? 'Click Add integration to connect an API, MCP server, or code repository.'
                    : 'A space editor or admin can connect APIs, MCP servers, and code repositories.'
                  : 'Try a different filter, or add a new integration.'
              }
            />
          ) : (
            items.map((item) =>
              item.kind === 'api' ? (
                <ApiCard
                  key={`api:${item.def.apiId}`}
                  definition={item.def}
                  bindings={bindingsByApiId.get(item.def.apiId) ?? []}
                  credentialsByKey={credentialsByKey}
                  loadDetail={api.getDefinitionDetail}
                  kindBadge={<KindBadge kind="api" />}
                  readOnly={!canManage}
                  onConnect={() => {
                    setConnectDialog({ apiId: item.def.apiId });
                  }}
                  onEditConnection={(binding) => {
                    setConnectDialog({ apiId: item.def.apiId, editBinding: binding });
                  }}
                  onDeleteConnection={(binding) => {
                    setBindingDeleteTarget(binding);
                  }}
                  onEditDefinition={() => {
                    void (async () => {
                      const d = await api.getDefinitionDetail(item.def.apiId);
                      setEditApiDefinition(d);
                    })();
                  }}
                  onAddSecret={(key) => {
                    const existing = credentialsByKey.get(key);
                    setCredDialog({
                      credentialKey: key,
                      label: existing?.label ?? key,
                      existing: Boolean(existing),
                    });
                  }}
                  onDeleteApi={async () => {
                    await api.deleteDefinition(item.def.apiId);
                  }}
                  renderConnectionSimulation={(binding: ApiBindingSummary) =>
                    binding.fulfillment.mode === 'simulated' ? (
                      <SimulationPanel
                        spaceId={spaceId}
                        simulationId={binding.fulfillment.simulationId}
                      />
                    ) : null
                  }
                  {...(item.def.apiId === 'github' && filter === 'all'
                    ? {
                        renderConnectionRepos: (binding: ApiBindingSummary) => {
                          const repos = githubReposByConnectionId.get(binding.bindingId);
                          return repos?.length ? (
                            <Column gap="2">
                              <Text size="xs" weight="medium" color="secondary">
                                Repositories
                              </Text>
                              {repos.map((r) => renderRepoCard(r, true))}
                            </Column>
                          ) : null;
                        },
                      }
                    : {})}
                />
              ) : item.kind === 'mcp' ? (
                <McpIntegrationCard
                  key={`mcp:${item.def.serverId}`}
                  definition={item.def}
                  binding={firstMcpBindingByServerId.get(item.def.serverId)}
                  credentialsByKey={mcpCredentialsByKey}
                  kindBadge={<KindBadge kind="mcp" />}
                  readOnly={!canManage}
                  onEdit={() => {
                    setMcpFormTarget({ definition: item.def });
                  }}
                  onConnect={() => {
                    setMcpFormTarget({ definition: item.def });
                  }}
                  onDelete={() => {
                    setMcpDeleteTarget(item.def);
                  }}
                  onTest={() => {
                    const b = firstMcpBindingByServerId.get(item.def.serverId);
                    if (!b)
                      return Promise.resolve({ ok: false, message: 'No connection to test.' });
                    return mcp.testBinding(b.bindingId);
                  }}
                />
              ) : (
                renderRepoCard(item.def, false)
              ),
            )
          )}
        </Column>

        {showAddApi && (
          <ApiDefinitionFormDialog
            onSave={async (body) => {
              await api.saveDefinition(body);
              setShowAddApi(false);
            }}
            onClose={() => {
              setShowAddApi(false);
            }}
          />
        )}

        {editApiDefinition && (
          <ApiDefinitionFormDialog
            initialDefinition={editApiDefinition}
            onSave={async (body) => {
              await api.saveDefinition(body);
              setEditApiDefinition(null);
            }}
            onClose={() => {
              setEditApiDefinition(null);
            }}
          />
        )}

        {connectDialog && (
          <ApiConnectApiDialog
            apiId={connectDialog.apiId}
            variables={apiDefinitionByApiId.get(connectDialog.apiId)?.variables ?? []}
            baseUrlTemplate={apiDefinitionByApiId.get(connectDialog.apiId)?.baseUrlTemplate}
            existingBindingIds={
              bindingsByApiId.get(connectDialog.apiId)?.map((b) => b.bindingId) ?? []
            }
            {...(connectDialog.editBinding ? { editBinding: connectDialog.editBinding } : {})}
            onSave={async (body) => {
              await api.saveBinding(body);
            }}
            onSaveCredential={async (key, value, label) => {
              await api.saveCredential(key, value, label);
            }}
            onClose={() => {
              setConnectDialog(null);
            }}
          />
        )}

        {credDialog && (
          <ApiCredentialDialog
            credentialKey={credDialog.credentialKey}
            defaultLabel={credDialog.label}
            existing={credDialog.existing}
            onSave={async (value, label, description) => {
              await api.saveCredential(credDialog.credentialKey, value, label, description);
              setCredDialog(null);
            }}
            {...(credDialog.existing
              ? {
                  onDelete: async () => {
                    await api.deleteCredential(credDialog.credentialKey);
                    setCredDialog(null);
                  },
                }
              : {})}
            onClose={() => {
              setCredDialog(null);
            }}
          />
        )}

        {mcpFormTarget !== null &&
          (() => {
            const def = mcpFormTarget.definition;
            const existingBinding = def ? firstMcpBindingByServerId.get(def.serverId) : undefined;
            return (
              <McpIntegrationFormDialog
                {...(def ? { initialDefinition: def } : {})}
                {...(existingBinding ? { initialBinding: existingBinding } : {})}
                credentials={mcp.credentials}
                onSaveDefinition={mcp.saveDefinition}
                onSaveBinding={mcp.saveBinding}
                onSaveCredential={async (key, value, label) => {
                  await mcp.saveCredential(key, value, label);
                }}
                onDeleteCredential={(key) => mcp.deleteCredential(key)}
                onTest={(bindingId) => mcp.testBinding(bindingId)}
                onClose={() => {
                  setMcpFormTarget(null);
                }}
              />
            );
          })()}

        {mcpDeleteTarget && (
          <McpConfirmDeleteDialog
            open
            title={`Delete the ${mcpDeleteTarget.name} integration?`}
            body={
              <>
                <Text size="sm">
                  Removes the integration entirely — the connection, the saved secret, the cached
                  tool list, the pinned origin, and any linked OAuth state. Skills that depend on
                  this integration will show as <strong>not registered</strong> until you add it
                  back.
                </Text>
              </>
            }
            confirmLabel="Delete integration"
            isDeleting={isDeleting}
            onClose={closeMcpDelete}
            onConfirm={async () => {
              const target = mcpDeleteTarget;
              await runMcpDelete(async () => {
                await mcp.deleteDefinition(target.serverId);
              });
            }}
          />
        )}

        {repoFormTarget !== null && (
          <RepoBindingFormDialog
            {...(repoFormTarget.binding ? { initial: repoFormTarget.binding } : {})}
            connections={githubConnections}
            allGithubBindingIds={[...githubConnectionsById.keys()]}
            githubDefinitionExists={apiDefinitionByApiId.has('github')}
            spaceId={spaceId}
            onSaveBinding={repo.saveRepoBinding}
            onSaveConnection={api.saveBinding}
            onSaveCredential={async (key, value, label) => {
              await api.saveCredential(key, value, label);
            }}
            onClose={() => {
              setRepoFormTarget(null);
            }}
          />
        )}

        {repoArchiveTarget && (
          <McpConfirmDeleteDialog
            open
            title={`Remove the ${repoArchiveTarget.coordinate} repository?`}
            body={
              <Text size="sm">
                Archives the repo designation so the coding lane can no longer push to it. Skills
                that target this repository will show as <strong>not ready</strong> until you add it
                back. The git credential is left untouched.
              </Text>
            }
            confirmLabel="Remove repository"
            isDeleting={isArchivingRepo}
            onClose={closeRepoArchive}
            onConfirm={async () => {
              const target = repoArchiveTarget;
              await runRepoArchive(async () => {
                await repo.archiveRepoBinding(target.repoDesignationId);
              });
            }}
          />
        )}

        {bindingDeleteTarget &&
          (() => {
            const target = bindingDeleteTarget;
            const dependentRepoCount = repo.repoBindings.filter(
              (r) => r.connectionBindingId === target.bindingId,
            ).length;
            return (
              <McpConfirmDeleteDialog
                open
                title={`Delete the ${target.name} connection?`}
                body={
                  dependentRepoCount > 0 ? (
                    <Text size="sm">
                      {dependentRepoCount}{' '}
                      {dependentRepoCount === 1 ? 'repository resolves' : 'repositories resolve'}{' '}
                      git + the GitHub API through this connection and will fail until re-linked.
                      Remove or re-link {dependentRepoCount === 1 ? 'it' : 'them'} first.
                    </Text>
                  ) : (
                    <Text size="sm">
                      Removes this connection and its saved auth profile. Skills that call it will
                      fail until re-connected. The git credential is left untouched.
                    </Text>
                  )
                }
                confirmLabel="Delete connection"
                isDeleting={isDeletingBinding}
                onClose={closeBindingDelete}
                onConfirm={async () => {
                  await runBindingDelete(async () => {
                    await api.deleteBinding(target.bindingId);
                  });
                }}
              />
            );
          })()}
      </PageContainer>
    </>
  );
}
