/**
 * The product's user interface, shared by every application that serves it.
 *
 * Built with modules preserved rather than bundled, so each client component
 * keeps its own file and the `'use client'` directive stays on the boundary it
 * describes. Bundling this barrel emits one chunk with the directive dropped and
 * reports nothing — see `tsup.config.ts`.
 *
 * Re-exports only, and only what a consumer needs. Anything with a server
 * dependency belongs on a server entry, because a Next build follows what this
 * entry names.
 */
export { DOCUMENT_ATTRIBUTES, VIEWPORT } from './documentShell.js';

export { ThemeProvider, useTheme } from './providers/theme.js';
export type { Theme, ThemeContextValue } from './providers/theme.js';

export { AppShellWrapper } from './components/app-shell.js';
export { DashboardShell } from './components/dashboard-shell.js';
export { SpaceLayout } from './components/space-layout.js';
// The space layout's parts, each a client boundary in its own right: the build
// keeps a directive only on a module the barrel names.
export { PreferredSpacePersist } from './components/preferred-space-persist.js';
export { SpaceAccessGate } from './components/space-access-gate.js';
export { SpaceSlugHistoryRedirect } from './components/space-slug-history-redirect.js';
export { SpaceHostBindingsPage } from './screens/space-host-bindings.js';
export { SpaceCodePolicyPage } from './screens/space-settings-code.js';
export { SpaceComputePage } from './screens/space-settings-compute.js';
export { DangerZonePage } from './screens/space-settings-danger.js';
export { AgentMemoryPage } from './screens/space-settings-memory.js';
export { SpaceRulesPage } from './screens/space-settings-rules.js';
export { SpaceWritePolicyPage } from './screens/space-settings-write-policy.js';
export {
  OperationSelectTree,
  TreeHint,
  TreeLeaf,
  TreeSubGroup,
  treeRowStyle,
  useAgentOperations,
} from './components/catalog/OperationSelectTree.js';
export type { OperationSelectTreeProps } from './components/catalog/OperationSelectTree.js';
export {
  HelmsmanDiscoveryEditor,
  withHelmsmanOperations,
} from './components/cybernetic/HelmsmanDiscoveryEditor.js';
export type { HelmsmanDiscoveryEditorProps } from './components/cybernetic/HelmsmanDiscoveryEditor.js';
export {
  ModelDefaultsEditor,
  applyModelRoleChange,
  applyReasoningRoleChange,
} from './components/cybernetic/ModelDefaultsEditor.js';
export type { ModelRole } from './components/cybernetic/ModelDefaultsEditor.js';
export { OAuthClientsSection } from './components/oauth-apps/OAuthClientsSection.js';
export type { OAuthClientsSectionProps } from './components/oauth-apps/OAuthClientsSection.js';
export { useCredentials } from './hooks/use-credentials.js';
export type {
  CredentialField,
  CredentialMeta,
  CredentialStatus,
  ProviderDefinition,
} from './hooks/use-credentials.js';
export { useFlows } from './hooks/use-flows.js';
export { useOperationCatalog } from './hooks/use-operation-catalog.js';
export type { CatalogOperation, CatalogStepType } from './hooks/use-operation-catalog.js';
export { spaceOAuthClientsKey, useSpaceOAuthClients } from './hooks/use-space-oauth-clients.js';
export { useSpaceOperationGrants } from './hooks/use-space-operation-grants.js';
export type { BlockedOperation, SpaceOperationGrants } from './hooks/use-space-operation-grants.js';
export {
  TENANT_OAUTH_CLIENTS_KEY,
  TENANT_OAUTH_POLICY_KEY,
  useTenantOAuthClients,
  useTenantOAuthPolicy,
} from './hooks/use-tenant-oauth-clients.js';
export type {
  RotateClientSecretInput,
  TenantOAuthClientCreateInput,
} from './hooks/use-tenant-oauth-clients.js';
export { describeCron, describeWork } from './lib/triggers-describe.js';
// Everything, because this module is entirely types and re-exports a long list
// of them from the run-view contract; enumerating it here would drift.
export type * from './lib/types.js';
export { CyberneticSettingsPage } from './screens/space-settings-agent.js';
export { SpaceCredentialsPage } from './screens/space-settings-credentials.js';
export { SpaceGeneralPage } from './screens/space-settings-general.js';
export { SpaceOAuthAppsPage } from './screens/space-settings-oauth-apps.js';
export { TriggersPage } from './screens/space-triggers.js';
export { ChatPage } from './screens/space-chat.js';
export { DangerZoneTab } from './components/skill-designer/danger-zone-tab.js';
export { formatBatchSize } from './components/evals-tab/evalsDerive.js';
export { NON_TERMINAL } from './components/evals-tab/evalsStyles.js';
export { GraphCanvas } from './components/graph/index.js';
export { Sparkline } from './components/graph/Sparkline.js';
export { SkillsPage } from './screens/space-skills.js';
export { StepNode } from './components/agent-editor/StepNode.js';
export { flowToEdges, flowToNodes } from './lib/flow-to-graph.js';
export type { StepNodeData } from './lib/flow-to-graph.js';
export { SpaceIntegrationsPage } from './screens/space-integrations.js';
export { SpaceMemoryPage } from './screens/space-memory.js';
export { SpaceMemoryPathPage } from './screens/space-memory-path.js';
export { SpaceMembersPage } from './screens/space-settings-members.js';
export { AgentDetailPage } from './screens/space-agent-detail.js';
export { AgentEditPage } from './screens/space-agent-edit.js';
export { AgentNewPage } from './screens/space-agent-new.js';
export { RunRedirectPage } from './screens/space-run-redirect.js';
export {
  blendedRate,
  groupByProvider,
  isGroupOpen,
  matchesQuery,
  sortAssignableModels,
  toggleCollapsed,
} from './components/tenant-settings/modelGroups.js';
export type { CatalogModel } from './components/tenant-settings/modelGroups.js';
export { AccountIndexPage } from './screens/account-index.js';
export { AccountLayout } from './screens/account-layout.js';
export { AccountProfilePage } from './screens/account-profile.js';
export { ConnectedAccountsPage } from './screens/account-connected.js';
export { TenantSettingsIndex } from './screens/tenant-settings-index.js';
export { TenantSettingsLayout } from './screens/tenant-settings-layout.js';
export { TenantApiKeysPage } from './screens/tenant-api-keys.js';
export { TenantCredentialsPage } from './screens/tenant-credentials.js';
export { TenantOAuthAppsPage } from './screens/tenant-oauth-apps.js';
export { TenantComputePolicyPage } from './screens/tenant-compute.js';
export { TenantModelsPage } from './screens/tenant-models.js';
export { TenantAccessControlPage } from './screens/tenant-access-control.js';
export { TenantAgentPoliciesPage } from './screens/tenant-agent-policies.js';
export { TenantIntegrationsPolicyPage } from './screens/tenant-integrations-policy.js';
export { TenantStorePolicyPage } from './screens/tenant-store-policy.js';
export { TenantSpacesPage } from './screens/tenant-spaces.js';
export { ArchivedSpacesPage } from './screens/spaces-archived.js';
export { SpacesIndexPage } from './screens/spaces-index.js';
export { ActionIndicator } from './components/actionCenter/ActionIndicator.js';
export type { ActionIndicatorProps } from './components/actionCenter/ActionIndicator.js';
export { AppPageHeader } from './components/app-page-header.js';
export type { AppPageHeaderProps } from './components/app-page-header.js';
export {
  CyberneticProvider,
  triggerCyberneticRefresh,
  useCybernetic,
  useOptionalCybernetic,
} from './components/cybernetic-provider.js';
export { CyberneticSpaceShell } from './components/cybernetic-space-shell.js';
export { partitionLanes } from './hooks/use-action-center-lanes.js';
export type { ActionCenterLanes } from './hooks/use-action-center-lanes.js';
export {
  ACTION_CENTER_ALLOWED_ACTIONS,
  ACTION_CENTER_AUDIENCES,
  ACTION_CENTER_ITEM_KINDS,
} from './hooks/use-action-center-types.js';
export type {
  ActionCenterAllowedAction,
  ActionCenterAudience,
  ActionCenterFocusEvent,
  ActionCenterItem,
  ActionCenterItemExtension,
  ActionCenterItemKind,
  ActionCenterItemOrigin,
  CoachProposalExtension,
  OAuthConsentExtension,
  ApiWriteApprovalExtension,
  BrowserWriteApprovalExtension,
  WriteApprovalExtension,
} from './hooks/use-action-center-types.js';
export { useActionCenter } from './hooks/use-action-center.js';
export type {
  ActionCenterCounts,
  ActionCenterResolution,
  ActionCenterResolveResult,
  ProposalCardDetail,
  UseActionCenterResult,
} from './hooks/use-action-center.js';
export { useActiveSurface } from './hooks/use-active-surface.js';
export type { ActiveSurfaceStatus, UseActiveSurfaceResult } from './hooks/use-active-surface.js';
export { useResumeOnUnblock } from './hooks/use-resume-on-unblock.js';
export {
  useSessionEventListener,
  useSessionEvents,
  useSessionLiveDeltas,
} from './hooks/use-session-events.js';
export {
  useSpaceEntityEventListener,
  useSpaceEntityEvents,
} from './hooks/use-space-entity-events.js';
export type { UseSpaceEntityEventsResult } from './hooks/use-space-entity-events.js';
export { useActionCenterFocus } from './hooks/use-action-center-focus.js';
export type {
  ActionCenterFocusListener,
  ActionCenterFocusMessage,
} from './hooks/use-action-center-focus.js';
export { __resetRealtimeClientForTests, getRealtimeClient } from './lib/realtimeClient.js';
export type {
  ConnectionStatus,
  StatusListener,
  TopicListener,
  TopicSubscriptionHandle,
} from './lib/realtimeClient.js';
// The brokers are module singletons with a wide surface, and callers reach for
// the whole of one rather than a symbol from it — a registry, a subscribe, a
// resume. A namespace keeps that shape through the barrel, which a flat
// re-export cannot.
export * as actionCenterBroker from './hooks/action-center-broker.js';
export * as coachSurfaceBroker from './hooks/coach-surface-broker.js';
export * as sessionEventsBroker from './hooks/session-events-broker.js';
export type { LiveDeltaFrame } from './hooks/session-events-broker.js';
export * as entityEventsBroker from './hooks/entity-events-broker.js';
export { SpaceSettingsLayout } from './screens/space-settings-layout.js';
export { SkillsLayout } from './screens/space-skills-layout.js';
export { SkillSlugRedirect } from './screens/space-skill-detail.js';
export { FlowsPage } from './screens/space-agents.js';
export { AppletInstancePage } from './screens/space-applet-instance.js';
export { AppletsPage } from './screens/space-applets.js';
export { CatalogPage } from './screens/space-catalog.js';
export { SpaceIndex } from './screens/space-index.js';
export { RunDetailsPage } from './screens/space-session-detail.js';
export { RunsPage } from './screens/space-sessions.js';
export { SettingsIndex } from './screens/space-settings-index.js';
export { SimulationInspectorPage } from './screens/space-simulation-detail.js';
export { StorePage } from './screens/space-store.js';
export { StoreListingPage } from './screens/space-store-detail.js';
export {
  OperationChips,
  STEP_TYPE_META,
  StepTypeChips,
  getStepTypeColor,
  getStepTypeIcon,
} from './components/CatalogPickers.js';
export { APPLET_MIN_HEIGHT, AppletInstanceView } from './components/applet-instance-view.js';
export type { AppletInstanceViewProps } from './components/applet-instance-view.js';
export { ARTIFACT_MIN_HEIGHT, ArtifactRenderer } from './components/artifact-renderer.js';
export type { ArtifactFrameApi, ArtifactRendererProps } from './components/artifact-renderer.js';
export { OperationTree } from './components/catalog/OperationTree.js';
export type {
  JsonSchemaProperty,
  Operation,
  OperationTreeProps,
  StepType,
} from './components/catalog/OperationTree.js';
export { BaselinePanel } from './components/integrations-api/BaselinePanel.js';
export { RehearsePanel } from './components/integrations-api/RehearsePanel.js';
export type { RehearsePanelProps } from './components/integrations-api/RehearsePanel.js';
export { SimulationEditor } from './components/integrations-api/SimulationEditor.js';
export { MarkdownRenderer } from './components/markdown-renderer.js';
export type { MarkdownRendererProps } from './components/markdown-renderer.js';
export { NotInThisSpace } from './components/not-in-this-space.js';
export type { NotInThisSpaceProps } from './components/not-in-this-space.js';
export { RunTimeline } from './components/run-timeline.js';
export { RunSummaryBar } from './components/run-timeline/RunSummaryBar.js';
export type { RunSummary } from './components/run-timeline/RunSummaryBar.js';
export { StepGroupCard } from './components/run-timeline/StepGroupCard.js';
export {
  AGENT_TURN_OPERATION,
  buildTimelineEntries,
  computeRunSummary,
  resolveDelegateRole,
  stepGroupKey,
} from './components/run-timeline/buildTimelineEntries.js';
export {
  agentTurnLabel,
  eventColor,
  eventIcon,
  formatCostUsd,
  formatDuration,
  formatNumber,
  formatTime,
  formatTimeFull,
  friendlyEventLabel,
  friendlyOperationLabel,
  stepStatusColor,
  stepStatusIcon,
  stepStatusLabel,
  subflowEventColor,
  subflowEventIcon,
  subflowEventLabel,
} from './components/run-timeline/displayHelpers.js';
export { ev } from './components/run-timeline/eventAccessor.js';
export type {
  RunTimelineProps,
  StepGroup,
  SubflowEntry,
  TimelineEntry,
} from './components/run-timeline/types.js';
export { SetupChecklist } from './components/setup-checklist.js';
export { StateViewer } from './components/state-viewer.js';
export { BundleInside, ConnectorInside } from './components/store-detail/inside.js';
export { ARTIFACT_TYPE_LABELS, titleCaseId } from './components/store-detail/labels.js';
export {
  UninstallDialogBody,
  UninstallSuccessView,
  defaultKeepChoices,
} from './components/store-detail/uninstall.js';
export type { UninstallFlow } from './components/store-detail/uninstall.js';
export { UpdateDialogBody, UpdateSuccessView } from './components/store-detail/update.js';
export type { UpdateFlow } from './components/store-detail/update.js';
export {
  __resetForTests,
  acquireDocBlob,
  acquireDocBytes,
  docBytesUrl,
  heldDocCount,
} from './hooks/media-bytes-broker.js';
export type { DocBytes, HeldDocBlob, HeldDocBytes } from './hooks/media-bytes-broker.js';
export { useActivityBubble } from './hooks/use-activity-bubble.js';
export type { ActivitySignal } from './hooks/use-activity-bubble.js';
export { appletInstanceKey, useAppletInstance } from './hooks/use-applet-instance.js';
export type {
  AppletInstanceSnapshot,
  UseAppletInstanceResult,
} from './hooks/use-applet-instance.js';
export {
  artifactVersionViewKey,
  useArtifactVersionView,
} from './hooks/use-artifact-version-view.js';
export { useFlowDetail } from './hooks/use-flow-detail.js';
export { useMemoryOps } from './hooks/use-memory-ops.js';
export type {
  MemoryDeleteOutput,
  MemoryDocStat,
  MemoryGetOutput,
  MemoryMkdirOutput,
  MemoryPutOutput,
  MemoryQueryItem,
  MemoryQueryOutput,
  MemoryTrashItem,
  UseMemoryOpsReturn,
} from './hooks/use-memory-ops.js';
export { OAUTH_CONNECTIONS_KEY, useOAuthConnections } from './hooks/use-oauth-connections.js';
export type { DisconnectInput } from './hooks/use-oauth-connections.js';
export { useRunEvents } from './hooks/use-run-events.js';
export {
  carryInFlightMessages,
  deeperPageWouldAdvance,
  sseStartupForRun,
  supersedesLiveActivity,
  useRunReducer,
} from './hooks/use-run-reducer.js';
export type { LiveStreamActivity, SseStartup } from './hooks/use-run-reducer.js';
export {
  alwaysGenerates,
  describeAnswerSource,
  useFreezeBaseline,
  useRestoreBaseline,
  useSaveSimulation,
  useSeedBaseline,
  useSimulation,
  useSimulationRuns,
  useSimulationWorld,
  useSimulations,
} from './hooks/use-simulations.js';
export type {
  MintedBaseline,
  SimulationBaselineSummary,
  SimulationDiagnostic,
  SimulationEndpointReadiness,
  SimulationEndpointReport,
  SimulationReadinessCounts,
  SimulationRunSummary,
  SimulationSummary,
  SimulationWorld,
  SimulationWorldCollection,
} from './hooks/use-simulations.js';
export {
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
} from './hooks/use-store.js';
export type {
  ListingDisplayState,
  ListingInstalledState,
  StoreInstallInput,
  StoreListingDetail,
  StoreListingFilters,
  StoreListingSummary,
  StoreUninstallInput,
  StoreUpdateInput,
} from './hooks/use-store.js';
export { useSurfaceEvents } from './hooks/use-surface-events.js';
export type { UseSurfaceEventsReturn } from './hooks/use-surface-events.js';
export { createAppletMediaResponder } from './lib/applet-media.js';
export type { AppletMediaResponder, AppletMediaResponderOptions } from './lib/applet-media.js';
export { readRefusalDetail } from './lib/applet-refusal.js';
export type { AppletRefusalDetail } from './lib/applet-refusal.js';
export { MAX_CSV_ROWS, parseCsvRow } from './lib/csv-utils.js';
export {
  formatRelative,
  hueFromRunId,
  statusToBadgeVariant,
  statusToColor,
  statusToLabel,
} from './lib/display-utils.js';
export { fetchPayload } from './lib/fetch-payload.js';
export { unifiedDiffLines } from './lib/line-diff.js';
export type { DiffLine, DiffLineKind } from './lib/line-diff.js';
export { listingRequirementRows } from './lib/listing-requirements.js';
export type { ListingRequirementRow } from './lib/listing-requirements.js';
export { useOAuthConsentPopup } from './lib/oauthConsentPopup.js';
export type {
  OAuthConsentLaunchArgs,
  OAuthConsentPopupController,
} from './lib/oauthConsentPopup.js';
export {
  ACTION_ICONS,
  ACTION_LABELS,
  STEP_TYPE_FALLBACKS,
  humanizeToken,
  iconOpIdForTask,
  pickThinkingVerb,
  resolveActionIcon,
  resolveActionLabel,
  resolveTaskIcon,
} from './lib/op-labels.js';
export type { TaskIconInput } from './lib/op-labels.js';
export {
  clearPreferredSpaceSlugAction,
  persistPreferredSpaceSlugAction,
} from './lib/preferredSpace-actions.js';
export { NOBODY_PERSONA, rehearsalRunInput, rehearsalSearchParams } from './lib/rehearsal.js';
export type { RehearsalPin } from './lib/rehearsal.js';
export { THEMES, THEME_STORAGE_KEY, storedTheme } from './providers/themeStorage.js';
export { useAutoScrollToBottom } from './hooks/use-auto-scroll.js';
export { THINKING_CLASS_OPS } from './lib/op-labels.js';
export type { RunViewState } from './hooks/use-run-reducer.js';
export type { RunViewAction } from './hooks/use-run-reducer.js';
export { ROUTE_MANIFEST } from './routeManifest.js';
export type { RouteEntry, WebEdition } from './routeManifest.js';
export { SpaceGate } from './components/space-gate.js';
export { OnboardingFlow } from './components/onboarding-flow.js';
export {
  deferProviderSetup,
  isProviderSetupDeferred,
} from './components/provider-setup-deferral.js';
export { useSpaceDetail } from './hooks/use-space-detail.js';
export type { SpaceDetail } from './hooks/use-space-detail.js';
export { useChatModelOptions } from './hooks/useChatModelOptions.js';
export type { ModelOption, ModelOptionsState } from './hooks/useChatModelOptions.js';
export { BlockedSessionNotice } from './components/blocked-session-notice.js';
export { CreateSpaceDialog } from './components/create-space-dialog.js';
export { CreateSpaceForm } from './components/create-space-form.js';
export type { CreateSpaceResult } from './components/create-space-form.js';
export { NavigationProvider, useNavigation } from './components/navigation-provider.js';
export { SpaceSelector } from './components/space-selector.js';
export { UserAvatar, useCurrentUser } from './components/user-avatar.js';
export { ParticipantBadge } from './components/room/ParticipantBadge.js';

export {
  Providers,
  PublicPageProviders,
  isSoloSpace,
  useApi,
  useSpace,
  useSpaceFromRoute,
} from './components/providers.js';
export type { RouteSpace, SpaceInfo } from './components/providers.js';

export {
  flattenBackwardPages,
  nextBackwardPageParam,
  useApiBackwardQuery,
  useApiMutation,
  useApiQuery,
} from './hooks/useApiQuery.js';
export type {
  BackwardPage,
  UseApiBackwardQueryOptions,
  UseApiMutationOptions,
  UseApiQueryOptions,
} from './hooks/useApiQuery.js';
export { toEdition, useEdition, useHasSurface } from './hooks/useEdition.js';
export type { Edition } from './hooks/useEdition.js';
export { llmReadinessQueryKey, useSpaceLlmReadiness } from './hooks/useSpaceLlmReadiness.js';
export type { SpaceLlmReadiness } from './hooks/useSpaceLlmReadiness.js';

export { ApiError, apiErrorFromResponse, createQueryClient } from './lib/query-client.js';
export { resolveSpaceSlug, spaceRoute } from './lib/space-routes.js';

export { TabNav } from './TabNav.js';
export type { TabDef } from './TabNav.js';

export { SafeSvg } from './SafeSvg.js';
export { sanitizeSvg } from './sanitizeSvg.js';
export {
  MAX_ARRIVING_ITEMS,
  isArrivingBatch,
} from './components/chat/TranscriptEntranceContext.js';
export {
  ChipList,
  DetailRow,
  DetailsSection,
  StatusBadge,
  formatBytes,
  formatJson,
  formatMs,
  getApiStatus,
  methodBadgeVariant,
} from './components/integrations-api/helpers.js';
export { getMcpReadiness } from './components/integrations-mcp/mcpReadiness.js';
export type { McpReadiness } from './components/integrations-mcp/mcpReadiness.js';
export { useMcpIntegrations } from './components/integrations-mcp/use-mcp-integrations.js';
export type {
  McpBindingTestResult,
  McpServerBindingSummary,
  McpServerDefinitionSummary,
  McpToolFilter,
  SaveMcpBindingInput,
  SaveMcpServerInput,
} from './components/integrations-mcp/use-mcp-integrations.js';
export {
  displayCoordinate,
  effectiveGitCredentialKey,
  getReadiness,
} from './components/integrations-repo/repoReadiness.js';
export type { Readiness } from './components/integrations-repo/repoReadiness.js';
export { ProposalCard } from './components/cybernetic/ProposalCard.js';
export type {
  ProposalCardPayload,
  ProposalCardSummary,
} from './components/cybernetic/ProposalCard.js';
export { FeedbackPicker } from './components/feedback/FeedbackPicker.js';
export { nextReservedHeight } from './components/mount-when-near.js';
export {
  detectSemanticType,
  renderSemanticCard,
  semanticTypeLabel,
} from './components/semantic-card-renderer.js';
export { WorkflowRunSurfaceContainer } from './components/workflow-run-surface/index.js';
export {
  STALLED_THRESHOLD_MS,
  compactSkipReason,
  deriveRunControlVisibility,
  isTaskStalled,
  orbForRunStatus,
  orbForTaskStatus,
  runningStepCount,
  topoSortRows,
} from './components/workflow-run-surface/workflowRunSurfaceHelpers.js';
export type { SpaceRole } from './components/workflow-run-surface/workflowRunSurfaceHelpers.js';
export {
  formatSystemStatusLine,
  shouldShowActiveReview,
  useCoachSurface,
} from './hooks/use-coach-surface.js';
export type {
  CoachActionResult,
  CoachAnomalySummary,
  CoachProposalDetail,
  CoachProposalSummary,
} from './hooks/use-coach-surface.js';
export { useIntegrations } from './hooks/use-integrations.js';
export type {
  ApiBindingSummary,
  ApiBindingVariableMeta,
  ApiDefinitionDetail,
  ApiDefinitionSummary,
  ApiEndpointDetail,
  IntegrationCredentialMeta,
} from './hooks/use-integrations.js';
export { useRepoBindings } from './hooks/use-repo-bindings.js';
export type { RepoBindingSummary, SaveRepoBindingInput } from './hooks/use-repo-bindings.js';
