'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Connection, NodeTypes } from '@xyflow/react';
import {
  AnimatedHeight,
  Button,
  CollapsibleSide,
  Dialog,
  DiffView,
  Icon,
  Pulse,
  Spinner,
  Text,
  diffStats,
  diffJson,
  type IconName,
} from '@aflow/design-system';
import type {
  Workflow,
  SkillValidity,
  SkillCampaignContract,
  SkillAuthoringSnapshot,
  WorkflowCampaignView,
} from '@aflow/schemas';
import { useApiQuery } from '../../hooks/useApiQuery.js';
import { useManifestDraft } from './useManifestDraft.js';

import { GraphCanvas } from '../graph/index.js';
import {
  buildSkillGraph,
  GOAL_NODE_ID,
  ACTIVATION_NODE_ID,
  OUTCOMES_NODE_ID,
  CAMPAIGN_NODE_ID,
  type GraphLens,
  type SkillNodeData,
} from './skill-graph.js';
import {
  SkillGoalNode,
  SkillActivationNode,
  SkillTaskNode,
  SkillOutcomesNode,
  SkillCampaignNode,
  SkillSourceNode,
} from './SkillNodes.js';
import { SkillInspector } from './SkillInspector.js';
import { OutlineRail } from './OutlineRail.js';
import { IssuesPanel } from './IssuesPanel.js';
import { useSkillDraft } from './useSkillDraft.js';
import { useTasksWithEval } from './useTasksWithEval.js';
import { useSkillEvalSuite } from './useSkillEvalSuite.js';
import { useEvalDraft } from './useEvalDraft.js';
import { CoachPanel, useCoachCounts } from './CoachPanel.js';

const nodeTypes: NodeTypes = {
  skillGoal: SkillGoalNode as unknown as NodeTypes['skillGoal'],
  skillActivation: SkillActivationNode as unknown as NodeTypes['skillActivation'],
  skillTask: SkillTaskNode as unknown as NodeTypes['skillTask'],
  skillOutcomes: SkillOutcomesNode as unknown as NodeTypes['skillOutcomes'],
  skillCampaign: SkillCampaignNode as unknown as NodeTypes['skillCampaign'],
  skillSource: SkillSourceNode as unknown as NodeTypes['skillSource'],
};

const ANCHORS = new Set([GOAL_NODE_ID, ACTIVATION_NODE_ID, OUTCOMES_NODE_ID, CAMPAIGN_NODE_ID]);
type Direction = 'RIGHT' | 'DOWN';

const EVAL_TYPE_SHORT: Record<string, string> = {
  threshold: 'threshold',
  contains: 'contains',
  trace_bound: 'trace',
  judge: 'judge',
};

function Pane({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--surface-overlay-alpha)',
        border: '0px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-xs)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SkillDesigner({
  workflow,
  contractValidity,
  campaignContract,
  agentStepCounts,
  spaceId,
  slug,
  onDirtyChange,
  active = true,
}: {
  workflow: Workflow;
  contractValidity?: SkillValidity | undefined;
  /** The skill's campaign contract from its SkillManifest — when present, a
   *  read-only Campaign anchor node renders the field definitions. */
  campaignContract?: SkillCampaignContract | undefined;
  agentStepCounts?: Map<string, number> | undefined;
  spaceId: string;
  slug: string;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /** False while mounted-but-hidden (another tab active). On becoming visible the
   *  graph re-layouts so ReactFlow fits at real size rather than a 0-size mount. */
  active?: boolean | undefined;
}) {
  const {
    draft,
    baseline,
    dirty,
    validity,
    validating,
    saving,
    saveError,
    actions,
    undo,
    redo,
    canUndo,
    canRedo,
    discard,
    save,
  } = useSkillDraft({ workflow, contractValidity, spaceId, slug });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [direction, setDirection] = useState<Direction>('RIGHT');
  const [lens, setLens] = useState<GraphLens>('control');
  const [layoutKey, setLayoutKey] = useState(0);

  const tasksWithEval = useTasksWithEval(spaceId, slug);
  const evalSuite = useSkillEvalSuite(spaceId, slug);
  const evalDraft = useEvalDraft({ baseline: evalSuite, spaceId, slug });
  const coachCount = useCoachCounts(spaceId, slug);

  // Full-skill authoring snapshot: the manifest contract + the version token the
  // contract save preconditions on. The saved contract drives the Campaign node;
  // the draft is the editable buffer.
  const snapshot = useApiQuery<SkillAuthoringSnapshot>({
    key: ['space', spaceId, 'workflow', slug, 'authoring-snapshot'],
    path: `/spaces/${spaceId}/workflows/${slug}/authoring-snapshot`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });
  const savedContract = snapshot.data?.manifest?.campaign ?? campaignContract;
  const manifestDraft = useManifestDraft({
    goal: snapshot.data?.manifest?.goal ?? null,
    // Falls back to the detail-query contract so the editor agrees with the
    // Campaign node before the snapshot resolves (the save is token-gated).
    contract: snapshot.data?.manifest?.campaign ?? campaignContract ?? null,
    manifestHash: snapshot.data?.tokens.manifestHash ?? null,
    spaceId,
    slug,
  });
  // Identity fields freeze once a campaign is active. Shares the cache with the
  // Performance Campaigns card (same key + path).
  const campaignsQuery = useApiQuery<{ campaigns: WorkflowCampaignView[] }>({
    key: ['space', spaceId, 'workflow', slug, 'campaigns'],
    path: `/spaces/${spaceId}/workflows/${slug}/campaigns?status=all`,
    spaceId,
    staleTime: 30_000,
    enabled: !!slug,
  });
  const hasActiveCampaign = (campaignsQuery.data?.campaigns ?? []).some(
    (c) => c.campaign.status === 'active',
  );

  // Any unsaved buffer (graph, contract, or evals) must arm the navigation /
  // unload guards — not just the workflow draft.
  const anyDirty = dirty || manifestDraft.dirty || evalDraft.dirty;
  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  // Distinct eval-criterion type labels per task (from the live draft) — the
  // task node shows them as a reference instead of a bare "eval" badge.
  const taskEvalTypes = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [taskId, crits] of Object.entries(evalDraft.draft?.taskCriteria ?? {})) {
      const types = [...new Set(crits.map((c) => EVAL_TYPE_SHORT[c.type] ?? c.type))];
      if (types.length > 0) m.set(taskId, types);
    }
    return m;
  }, [evalDraft.draft]);

  const graph = useMemo(
    () =>
      buildSkillGraph(draft, {
        validity,
        agentStepCounts,
        lens,
        tasksWithEval,
        taskEvalTypes,
        campaignContract: savedContract,
      }),
    [draft, validity, agentStepCounts, lens, tasksWithEval, taskEvalTypes, savedContract],
  );
  const { errorCount, advisoryCount } = graph.diagnostics;

  // Hovering a producer's branch badge lights up its conditional out-edges.
  const [fanHoverSource, setFanHoverSource] = useState<string | null>(null);

  const nodes = useMemo(
    () =>
      graph.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          isSelected: n.id === selectedId,
          direction,
          onFanHover: setFanHoverSource,
        },
      })),
    [graph.nodes, selectedId, direction],
  );

  const edges = useMemo(
    () =>
      fanHoverSource
        ? graph.edges.map((e) =>
            e.source === fanHoverSource && e.data?.['conditional']
              ? { ...e, animated: true, style: { ...e.style, strokeWidth: 3 } }
              : e,
          )
        : graph.edges,
    [graph.edges, fanHoverSource],
  );

  const locate = useCallback((taskId: string | null) => {
    if (taskId) {
      setSelectedId(taskId);
      setIssuesOpen(true);
    }
  }, []);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      if (ANCHORS.has(c.source) || ANCHORS.has(c.target)) return;
      if (c.source.startsWith('src:') || c.target.startsWith('src:')) return;
      if (lens === 'data') {
        // Drag producer→consumer to wire a task_output binding; refine the
        // exact output path in the inspector.
        actions.bindWholeOutput(c.target, c.source);
        setSelectedId(c.target);
        return;
      }
      actions.addDependency(c.source, c.target);
    },
    [actions, lens],
  );

  const relayout = () => {
    setLayoutKey((k) => k + 1);
  };
  const toggleDirection = () => {
    setDirection((d) => (d === 'RIGHT' ? 'DOWN' : 'RIGHT'));
    relayout();
  };
  const toggleLens = () => {
    setLens((l) => (l === 'control' ? 'data' : 'control'));
    relayout();
  };

  const canSave = dirty && validity?.status === 'valid' && !validating && !saving;

  const diffLines = useMemo(
    () => (dirty ? diffJson(baseline, draft) : []),
    [dirty, baseline, draft],
  );
  const changeCount = useMemo(() => {
    const s = diffStats(diffLines);
    return s.added + s.removed;
  }, [diffLines]);

  useEffect(() => {
    if (!dirty) setReviewOpen(false);
  }, [dirty]);

  // Re-layout when this becomes the visible tab — under display:none the graph
  // may have mounted at 0 size, leaving ReactFlow unfitted until a manual resize.
  useEffect(() => {
    if (active) setLayoutKey((k) => k + 1);
  }, [active]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          gap: 'var(--space-sm)',
          backgroundColor: 'var(--surface-overlay-alpha)',
          padding: 'var(--space-2-5)',
          borderRadius: 'var(--radius-lg)',
          margin: 'var(--space-2)',
        }}
      >
        <CollapsibleSide
          side="left"
          defaultWidth={248}
          minWidth={190}
          maxWidth={380}
          defaultCollapsed
          icon="list"
          label="Outline"
        >
          <Pane>
            <OutlineRail
              workflow={draft}
              selectedId={selectedId}
              diagnostics={graph.diagnostics}
              onSelect={setSelectedId}
              hasCampaign={!!savedContract && Object.keys(savedContract.fields).length > 0}
            />
          </Pane>
        </CollapsibleSide>

        <Pane style={{ flex: 1, minWidth: 0 }}>
          <GraphCanvas<SkillNodeData>
            key={layoutKey}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            selectedNodeId={selectedId}
            onSelectNode={setSelectedId}
            onConnect={onConnect}
            editable
            showMiniMap
            showControls
            canvasBackground="var(--surface-overlay-alpha)"
            layoutOptions={{
              direction,
              layerSpacing: 120,
              nodeSpacing: 80,
              padding: 64,
              nodeWidth: 320,
              nodeHeight: 250,
            }}
            fitViewOptions={{ padding: 0.16, minZoom: 0.2, maxZoom: 1.1 }}
          />
        </Pane>

        <CollapsibleSide
          side="right"
          defaultWidth={372}
          minWidth={280}
          maxWidth={560}
          icon="sliders"
          label="Inspector"
        >
          <Pane>
            <SkillInspector
              workflow={draft}
              selectedId={selectedId}
              diagnostics={graph.diagnostics}
              spaceId={spaceId}
              actions={actions}
              evalDraft={evalDraft}
              workflowDirty={dirty}
              manifestDraft={manifestDraft}
              savedContract={savedContract}
              hasActiveCampaign={hasActiveCampaign}
              slug={slug}
            />
          </Pane>
        </CollapsibleSide>

        <CollapsibleSide
          side="right"
          defaultWidth={340}
          minWidth={260}
          maxWidth={520}
          defaultCollapsed
          icon="stethoscope"
          label="Coach"
          badge={coachCount}
        >
          <Pane>
            <CoachPanel spaceId={spaceId} slug={slug} />
          </Pane>
        </CollapsibleSide>
      </div>

      <div style={{ padding: '0 var(--space-2) var(--space-2)' }}>
        <Pane>
          <BottomBar
            errorCount={errorCount}
            advisoryCount={advisoryCount}
            issuesOpen={issuesOpen}
            direction={direction}
            lens={lens}
            dirty={dirty}
            validating={validating}
            saving={saving}
            saveError={saveError}
            canUndo={canUndo}
            canRedo={canRedo}
            changeCount={changeCount}
            onReview={() => {
              setReviewOpen(true);
            }}
            onToggleIssues={() => {
              setIssuesOpen((v) => !v);
            }}
            onRelayout={relayout}
            onToggleDirection={toggleDirection}
            onToggleLens={toggleLens}
            onAddTask={actions.addTask}
            onUndo={undo}
            onRedo={redo}
            onDiscard={discard}
          />
          <AnimatedHeight>
            {issuesOpen ? (
              <div
                style={{
                  maxHeight: 200,
                  overflow: 'auto',
                  borderTop: '1px solid var(--color-border-subtle)',
                }}
              >
                <IssuesPanel diagnostics={graph.diagnostics} onLocate={locate} />
              </div>
            ) : (
              <div />
            )}
          </AnimatedHeight>
        </Pane>
      </div>

      <Dialog
        open={reviewOpen}
        onClose={() => {
          setReviewOpen(false);
        }}
        title="Review changes"
        width="xl"
        footer={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-sm)',
              width: '100%',
            }}
          >
            <Text size="sm" color="muted">
              {changeCount} line change{changeCount === 1 ? '' : 's'} · saved → draft
            </Text>
            {saveError && (
              <Text size="sm" tone="danger" style={{ maxWidth: 360 }} truncate>
                {saveError}
              </Text>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-sm)' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  discard();
                  setReviewOpen(false);
                }}
                disabled={saving}
              >
                Discard
              </Button>
              <Button variant="primary" size="sm" onClick={() => void save()} disabled={!canSave}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            {validating ? (
              <Spinner size="sm" label="Validating" />
            ) : errorCount === 0 ? (
              <Text size="sm" style={{ color: 'var(--color-success-default)' }} weight="semibold">
                ✓ Contract valid
              </Text>
            ) : (
              <Text size="sm" tone="danger" weight="semibold">
                {errorCount} error{errorCount > 1 ? 's' : ''} — fix before saving
              </Text>
            )}
            {advisoryCount > 0 && (
              <Text size="sm" tone="warning">
                · {advisoryCount} advisory
              </Text>
            )}
          </div>
          <DiffView lines={diffLines} maxHeight="58vh" emptyLabel="No changes to save" />
        </div>
      </Dialog>
    </div>
  );
}

function BottomBar(props: {
  errorCount: number;
  advisoryCount: number;
  issuesOpen: boolean;
  direction: Direction;
  lens: GraphLens;
  dirty: boolean;
  validating: boolean;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  changeCount: number;
  onReview: () => void;
  onToggleIssues: () => void;
  onRelayout: () => void;
  onToggleDirection: () => void;
  onToggleLens: () => void;
  onAddTask: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;
}) {
  const valid = props.errorCount === 0;
  const pillColor = valid ? 'var(--color-success-default)' : 'var(--color-error-default, #ef4444)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        onClick={props.onToggleIssues}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
          background: `${pillColor}14`,
          border: `1px solid ${pillColor}40`,
          borderRadius: 'var(--radius-full)',
          padding: '5px 12px',
          cursor: 'pointer',
        }}
      >
        <Pulse active={valid} color={pillColor}>
          <span
            style={{
              display: 'block',
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: pillColor,
            }}
          />
        </Pulse>
        <Text size="sm" weight="semibold" style={{ color: pillColor }}>
          {valid ? 'Contract valid' : `${props.errorCount} error${props.errorCount > 1 ? 's' : ''}`}
        </Text>
        {props.advisoryCount > 0 && (
          <Text size="sm" tone="warning">
            · {props.advisoryCount} advisory
          </Text>
        )}
        <Icon name={props.issuesOpen ? 'caret-down' : 'caret-up'} size="xs" />
      </button>

      {props.validating && <Spinner size="sm" label="Validating" />}
      {props.dirty && !props.validating && (
        <Text size="sm" color="muted">
          Unsaved changes
        </Text>
      )}
      {props.saveError && (
        <Text size="sm" tone="danger" style={{ maxWidth: 320 }} truncate>
          {props.saveError}
        </Text>
      )}

      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-sm)',
        }}
      >
        <button
          type="button"
          onClick={props.onToggleLens}
          title="Toggle control / data-flow lens"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-xs)',
            color:
              props.lens === 'data' ? 'var(--color-info-default)' : 'var(--color-text-secondary)',
            background: props.lens === 'data' ? 'var(--color-surface-2)' : 'transparent',
            border: `1px solid ${props.lens === 'data' ? 'var(--color-info-default)' : 'var(--color-border-subtle)'}`,
            borderRadius: 'var(--radius-full)',
            padding: '5px 12px',
            cursor: 'pointer',
          }}
        >
          <Icon name={props.lens === 'data' ? 'flow' : 'git-branch'} size="xs" />
          <Text size="sm">{props.lens === 'data' ? 'Data flow' : 'Control flow'}</Text>
        </button>
        <BarButton icon="plus" label="Task" onClick={props.onAddTask} title="Add a task" />
        <BarButton
          icon="undo"
          label=""
          onClick={props.onUndo}
          title="Undo"
          disabled={!props.canUndo}
        />
        <BarButton
          icon="refresh"
          label=""
          onClick={props.onRedo}
          title="Redo"
          disabled={!props.canRedo}
        />
        <BarButton
          icon={props.direction === 'RIGHT' ? 'columns' : 'rows'}
          label={props.direction === 'RIGHT' ? 'Horizontal' : 'Vertical'}
          onClick={props.onToggleDirection}
          title="Toggle layout direction"
        />
        <BarButton
          icon="flow"
          label="Auto-layout"
          onClick={props.onRelayout}
          title="Reset layout"
        />
        {props.dirty && (
          <Button variant="ghost" size="sm" onClick={props.onDiscard} disabled={props.saving}>
            Discard
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={props.onReview}
          disabled={!props.dirty || props.saving}
          title="Review changes and save"
        >
          {props.changeCount > 0 ? `Review & Save (${props.changeCount})` : 'Review & Save'}
        </Button>
      </div>
    </div>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  title,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  title: string;
  disabled?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-xs)',
        color: 'var(--color-text-secondary)',
        background: 'transparent',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-full)',
        padding: '5px 12px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Icon name={icon} size="xs" />
      {label && <Text size="sm">{label}</Text>}
    </button>
  );
}
