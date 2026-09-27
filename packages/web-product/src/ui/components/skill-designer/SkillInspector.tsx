'use client';

import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Icon,
  Input,
  Select,
  Text,
  type IconName,
} from '@aflow/design-system';
import { CampaignFormDialog } from '../workflow/CampaignFormDialog.js';
import {
  inferTaskType,
  workflowWhenView,
  type Workflow,
  type WorkflowTask,
  type SkillDiagnostic,
  type EvalCriterion,
  type SkillCampaignContract,
  type CampaignContractField,
} from '@aflow/schemas';
import {
  FIELD_KEY_RE,
  type UseManifestDraft,
  type ContractDraftActions,
} from './useManifestDraft.js';

import {
  GOAL_NODE_ID,
  ACTIVATION_NODE_ID,
  OUTCOMES_NODE_ID,
  CAMPAIGN_NODE_ID,
  deriveTaskOutputs,
  type DiagnosticsIndex,
} from './skill-graph.js';
import type { SkillDraftActions } from './useSkillDraft.js';
import { useModelOptions, type SelectOption } from './useModelOptions.js';
import {
  InspectorHeader,
  Section,
  Empty,
  Mono,
  KV,
  Editable,
  Sel,
  DiagRow,
  bindingSummary,
  evaluatorDetail,
  MODE_ICON,
  ACCENT_GOAL,
  MODE_OPTIONS,
  DISPATCH_OPTIONS,
} from './inspectorShared.js';
import {
  ConsumesEditor,
  ProducesEditor,
  StateVarsEditor,
  EvaluatorEditor,
} from './inspectorEditors.js';
import { CapabilitiesEditor } from './inspectorCapabilities.js';
import { EvalCriteriaSection } from './inspectorEvals.js';
import type { UseEvalDraft, EvalTier } from './useEvalDraft.js';

export function SkillInspector({
  workflow,
  selectedId,
  diagnostics,
  spaceId,
  actions,
  evalDraft,
  workflowDirty,
  manifestDraft,
  savedContract,
  hasActiveCampaign,
  slug,
}: {
  workflow: Workflow;
  selectedId: string | null;
  diagnostics: DiagnosticsIndex;
  spaceId: string;
  /** The skill's workflow slug — needed to start a campaign from the node. */
  slug: string;
  /** When present, fields become editable and mutate the draft. */
  actions?: SkillDraftActions | undefined;
  /** Operator-editable eval draft — surfaced per goal / task with remove. */
  evalDraft?: UseEvalDraft | undefined;
  /** Task-scoped eval saves validate against the persisted workflow, so eval
   *  Save is blocked while the workflow draft is dirty (§9). */
  workflowDirty?: boolean | undefined;
  /** Operator-editable manifest draft (goal + campaign contract; one patch save). */
  manifestDraft?: UseManifestDraft | undefined;
  /** The persisted contract — a started campaign uses this, not the live edit. */
  savedContract?: SkillCampaignContract | undefined;
  /** True when a campaign is active — identity fields are frozen. */
  hasActiveCampaign?: boolean | undefined;
}) {
  const modelOptions = useModelOptions();
  const evalSuite = evalDraft?.draft ?? null;
  const removeFrom = (tier: EvalTier): ((name: string) => void) | undefined =>
    evalDraft
      ? (name: string) => {
          evalDraft.actions.removeCriterion(tier, name);
        }
      : undefined;
  const addTo = (tier: EvalTier): ((c: EvalCriterion) => void) | undefined =>
    evalDraft
      ? (c: EvalCriterion) => {
          evalDraft.actions.addCriterion(tier, c);
        }
      : undefined;

  let body: ReactNode;
  if (!selectedId)
    body = <SkillMeta workflow={workflow} diagnostics={diagnostics} actions={actions} />;
  else if (selectedId === GOAL_NODE_ID)
    body = (
      <GoalInspector
        workflow={workflow}
        actions={actions}
        manifestDraft={manifestDraft}
        hasActiveCampaign={hasActiveCampaign ?? false}
        goalCriteria={evalSuite?.goalCriteria ?? []}
        trajectoryCriteria={evalSuite?.trajectoryCriteria ?? []}
        onRemoveGoal={removeFrom({ scope: 'goal' })}
        onRemoveTrajectory={removeFrom({ scope: 'trajectory' })}
        onAddGoal={addTo({ scope: 'goal' })}
        onAddTrajectory={addTo({ scope: 'trajectory' })}
      />
    );
  else if (selectedId === ACTIVATION_NODE_ID)
    body = <ActivationInspector workflow={workflow} actions={actions} />;
  else if (selectedId === OUTCOMES_NODE_ID)
    body = <OutcomesInspector workflow={workflow} actions={actions} />;
  else if (selectedId === CAMPAIGN_NODE_ID && manifestDraft)
    body = (
      <CampaignInspector
        draft={manifestDraft}
        savedContract={savedContract}
        hasActiveCampaign={hasActiveCampaign ?? false}
        spaceId={spaceId}
        slug={slug}
      />
    );
  else {
    const task = workflow.tasks.find((t) => t.taskId === selectedId);
    body = task ? (
      <TaskInspector
        task={task}
        workflow={workflow}
        diags={diagnostics.byTask.get(task.taskId) ?? []}
        actions={actions}
        modelOptions={modelOptions}
        spaceId={spaceId}
        taskCriteria={evalSuite?.taskCriteria?.[task.taskId] ?? []}
        onRemoveCriterion={removeFrom({ scope: 'task', taskId: task.taskId })}
        onAddCriterion={addTo({ scope: 'task', taskId: task.taskId })}
      />
    ) : (
      <SkillMeta workflow={workflow} diagnostics={diagnostics} actions={actions} />
    );
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {evalDraft?.dirty && (
        <EvalSaveBar evalDraft={evalDraft} workflowDirty={workflowDirty ?? false} />
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-lg)' }}>
        {body}
      </div>
    </div>
  );
}

function EvalSaveBar({
  evalDraft,
  workflowDirty,
}: {
  evalDraft: UseEvalDraft;
  workflowDirty: boolean;
}) {
  const n = evalDraft.changeCount;
  const blocked = workflowDirty;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        borderBottom: '1px solid var(--color-border-subtle)',
        background: 'var(--color-surface-1)',
        flexWrap: 'wrap',
      }}
    >
      <Icon name="check-circle" size="xs" color="var(--color-info-default)" />
      <Text size="sm" weight="semibold">
        {n} eval change{n === 1 ? '' : 's'}
      </Text>
      {blocked && (
        <Text size="xs" tone="warning">
          save the workflow first
        </Text>
      )}
      {evalDraft.saveError && (
        <Text size="xs" tone="danger" truncate style={{ maxWidth: 200 }}>
          {evalDraft.saveError}
        </Text>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-xs)' }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            evalDraft.actions.discard();
          }}
          disabled={evalDraft.saving}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void evalDraft.save('Operator eval edit')}
          disabled={blocked || evalDraft.saving}
        >
          {evalDraft.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill meta (nothing selected) — skill-wide properties
// ---------------------------------------------------------------------------

function SkillMeta({
  workflow,
  diagnostics,
  actions,
}: {
  workflow: Workflow;
  diagnostics: DiagnosticsIndex;
  actions?: SkillDraftActions | undefined;
}) {
  return (
    <div style={{ margin: 'var(--space-2-5)' }}>
      <InspectorHeader icon="skill" kind="Skill" title={workflow.name} accent={ACCENT_GOAL} />
      <Section label="Name">
        <Editable
          value={workflow.name}
          onChange={
            actions
              ? (v) => {
                  actions.patchWorkflow({ name: v });
                }
              : undefined
          }
        />
      </Section>
      <Section label="Description">
        <Editable
          value={workflow.description ?? ''}
          multiline
          onChange={
            actions
              ? (v) => {
                  actions.patchWorkflow({ description: v });
                }
              : undefined
          }
        />
      </Section>
      <Section label="Mode">
        {actions ? (
          <Sel
            value={workflow.mode}
            options={MODE_OPTIONS}
            onChange={(v) => {
              actions.patchWorkflow({ mode: v as Workflow['mode'] });
            }}
          />
        ) : (
          <Badge
            variant="neutral"
            icon={<Icon name={MODE_ICON[workflow.mode] ?? 'bullseye'} size="xs" />}
          >
            {workflow.mode}
          </Badge>
        )}
      </Section>
      <Section label="Run state">
        {actions ? (
          <StateVarsEditor workflow={workflow} actions={actions} />
        ) : (workflow.stateVariables ?? []).length === 0 ? (
          <Empty>No run state.</Empty>
        ) : (
          (workflow.stateVariables ?? []).map((v) => (
            <KV
              k={v.name}
              key={v.variableId}
              v={
                <Mono>
                  {[
                    v.required && 'required',
                    v.sensitive && 'sensitive',
                    v.immutable && 'immutable',
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </Mono>
              }
            />
          ))
        )}
      </Section>
      <Section label="At a glance">
        <KV k="Tasks" v={String(workflow.tasks.length)} />
        <KV k="Outcomes" v={String(workflow.outcomes.length)} />
        <KV k="Revision" v={String(workflow.revision)} />
        <KV
          k="Contract"
          v={
            diagnostics.errorCount === 0 ? (
              <Text size="sm" tone="success">
                valid
              </Text>
            ) : (
              <Text size="sm" tone="danger">
                {diagnostics.errorCount} error{diagnostics.errorCount > 1 ? 's' : ''}
              </Text>
            )
          }
        />
      </Section>
    </div>
  );
}

/**
 * Edits the manifest goal (the structured `SkillGoal`, distinct from the
 * workflow's prose goal). v1 edits the subjective rubric; numeric / objective
 * goals are shown read-only.
 */
function GoalDefinitionEditor({
  draft,
  hasActiveCampaign,
}: {
  draft: UseManifestDraft;
  hasActiveCampaign: boolean;
}) {
  const goal = draft.goal;
  if (!goal) return null;

  if (goal.type === 'subjective') {
    const rubric = goal.rubric;
    const setRubric = (next: string[]) => {
      draft.setGoal({ type: 'subjective', rubric: next });
    };
    return (
      <Section label="Success rubric">
        <Text size="sm" color="muted" style={{ marginBottom: 'var(--space-xs)' }}>
          What a successful run looks like — judge-style evals score against these lines.
        </Text>
        {rubric.map((line, i) => (
          <div
            key={i}
            style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-xs)' }}
          >
            <Input
              value={line}
              error={!line.trim()}
              aria-label={`Rubric line ${String(i + 1)}`}
              onChange={(e) => {
                setRubric(rubric.map((r, j) => (j === i ? e.target.value : r)));
              }}
              style={{ flex: 1 }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={rubric.length <= 1}
              onClick={() => {
                setRubric(rubric.filter((_, j) => j !== i));
              }}
            >
              <Icon name="trash" size="xs" />
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          disabled={rubric.length >= 20}
          onClick={() => {
            setRubric([...rubric, '']);
          }}
        >
          <Icon name="plus" size="xs" /> Add line
        </Button>
      </Section>
    );
  }

  if (goal.type === 'numeric') {
    const direction = typeof goal.direction === 'string' ? goal.direction : '$campaign';
    return (
      <Section label="Optimization goal">
        {hasActiveCampaign && (
          <Text
            size="xs"
            tone="warning"
            style={{ display: 'block', marginBottom: 'var(--space-xs)' }}
          >
            A campaign is active — the metric and direction define its identity and are read-only
            here.
          </Text>
        )}
        <KV k="Metric" v={<Mono>{goal.metricKey}</Mono>} />
        <KV k="Direction" v={<Badge variant="neutral">{direction}</Badge>} />
        <Text size="xs" color="muted">
          Numeric-goal editing is authored with the agent for now.
        </Text>
      </Section>
    );
  }

  return (
    <Section label="Goal definition">
      <Text size="sm" color="muted">
        This skill uses an objective (pass/fail) goal — edit its criteria with the agent.
      </Text>
    </Section>
  );
}

function GoalInspector({
  workflow,
  actions,
  manifestDraft,
  hasActiveCampaign,
  goalCriteria,
  trajectoryCriteria,
  onRemoveGoal,
  onRemoveTrajectory,
  onAddGoal,
  onAddTrajectory,
}: {
  workflow: Workflow;
  actions?: SkillDraftActions | undefined;
  manifestDraft?: UseManifestDraft | undefined;
  hasActiveCampaign: boolean;
  goalCriteria: EvalCriterion[];
  trajectoryCriteria: EvalCriterion[];
  onRemoveGoal?: ((name: string) => void) | undefined;
  onRemoveTrajectory?: ((name: string) => void) | undefined;
  onAddGoal?: ((c: EvalCriterion) => void) | undefined;
  onAddTrajectory?: ((c: EvalCriterion) => void) | undefined;
}) {
  return (
    <div>
      <InspectorHeader
        icon="bullseye"
        kind="Skill goal"
        title={workflow.name}
        accent={ACCENT_GOAL}
      />
      {manifestDraft?.dirty && <ManifestSaveBar draft={manifestDraft} />}
      <Section label="Skill name">
        <Editable
          value={workflow.name}
          onChange={
            actions
              ? (v) => {
                  actions.patchWorkflow({ name: v });
                }
              : undefined
          }
        />
      </Section>
      <Section label="Goal">
        <Editable
          value={workflow.goal ?? ''}
          multiline
          placeholder="What is this skill trying to achieve?"
          onChange={
            actions
              ? (v) => {
                  actions.patchWorkflow({ goal: v });
                }
              : undefined
          }
        />
      </Section>
      {manifestDraft?.goal && (
        <GoalDefinitionEditor draft={manifestDraft} hasActiveCampaign={hasActiveCampaign} />
      )}
      <Section label="Mode">
        {actions ? (
          <Sel
            value={workflow.mode}
            options={MODE_OPTIONS}
            onChange={(v) => {
              actions.patchWorkflow({ mode: v as Workflow['mode'] });
            }}
          />
        ) : (
          <Badge
            variant="neutral"
            icon={<Icon name={MODE_ICON[workflow.mode] ?? 'bullseye'} size="xs" />}
          >
            {workflow.mode}
          </Badge>
        )}
      </Section>
      <EvalCriteriaSection
        label="Verified — goal"
        criteria={goalCriteria}
        emptyHint="No eval criteria yet. The Coach adds these from run evidence; none is a valid state."
        onRemove={onRemoveGoal}
        onAdd={onAddGoal}
      />
      <EvalCriteriaSection
        label="Verified — trajectory"
        criteria={trajectoryCriteria}
        onRemove={onRemoveTrajectory}
        onAdd={onAddTrajectory}
      />
    </div>
  );
}

function ActivationInspector({
  workflow,
  actions,
}: {
  workflow: Workflow;
  actions?: SkillDraftActions | undefined;
}) {
  const act = workflow.activation;
  const setAct = (patch: Record<string, unknown>) => {
    if (!actions) return;
    const cur = act ?? { triggerPatterns: [], activationHint: '', priority: 50 };
    actions.patchWorkflow({ activation: { ...cur, ...patch } as Workflow['activation'] });
  };
  const setIteration = (patch: Record<string, unknown>) => {
    if (!actions) return;
    const cur = workflow.iteration ?? { auto: true };
    actions.patchWorkflow({ iteration: { ...cur, ...patch } as Workflow['iteration'] });
  };
  const setBudget = (patch: Record<string, unknown>) => {
    if (!actions) return;
    actions.patchWorkflow({
      budget: { ...(workflow.budget ?? {}), ...patch } as Workflow['budget'],
    });
  };
  const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v) || 0);
  return (
    <div>
      <InspectorHeader
        icon="lightning"
        kind="Activation"
        title="When this skill runs"
        accent="var(--color-success-default)"
      />
      <Section label="Activation hint">
        <Editable
          value={act?.activationHint ?? ''}
          multiline
          placeholder="Describe when this skill should activate."
          onChange={
            actions
              ? (v) => {
                  setAct({ activationHint: v });
                }
              : undefined
          }
        />
      </Section>
      <Section label="Trigger patterns (comma-separated)">
        {actions ? (
          <Editable
            value={(act?.triggerPatterns ?? []).join(', ')}
            placeholder="optimize, tune, kaggle"
            onChange={(v) => {
              setAct({
                triggerPatterns: v
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
          />
        ) : (act?.triggerPatterns ?? []).length === 0 ? (
          <Empty>None</Empty>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' }}>
            {act!.triggerPatterns.map((p) => (
              <Badge key={p} variant="neutral">
                {p}
              </Badge>
            ))}
          </div>
        )}
      </Section>
      <Section label="Priority">
        <Editable
          value={String(act?.priority ?? 50)}
          type="number"
          onChange={
            actions
              ? (v) => {
                  setAct({ priority: Number(v) || 0 });
                }
              : undefined
          }
        />
      </Section>
      <Section label="Iteration">
        {actions ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
            }}
          >
            <Text size="sm" color="muted">
              Auto-iterate
            </Text>
            <Sel
              value={workflow.iteration?.auto ? 'yes' : 'no'}
              options={[
                { value: 'no', label: 'no' },
                { value: 'yes', label: 'yes' },
              ]}
              width={90}
              onChange={(v) => {
                setIteration({ auto: v === 'yes' });
              }}
            />
          </div>
        ) : (
          <KV k="Auto-iterate" v={workflow.iteration?.auto ? 'yes' : 'no'} />
        )}
        <KV
          k="Max consecutive runs"
          v={
            <Editable
              value={String(workflow.iteration?.maxConsecutiveRuns ?? '')}
              type="number"
              placeholder="∞"
              onChange={
                actions
                  ? (v) => {
                      setIteration({ maxConsecutiveRuns: num(v) });
                    }
                  : undefined
              }
            />
          }
        />
      </Section>
      <Section label="Budget">
        <KV
          k="Max runs"
          v={
            <Editable
              value={String(workflow.budget?.maxRuns ?? '')}
              type="number"
              placeholder="none"
              onChange={
                actions
                  ? (v) => {
                      setBudget({ maxRuns: num(v) });
                    }
                  : undefined
              }
            />
          }
        />
        <KV
          k="Max cost (cents)"
          v={
            <Editable
              value={String(workflow.budget?.maxCostCents ?? '')}
              type="number"
              placeholder="none"
              onChange={
                actions
                  ? (v) => {
                      setBudget({ maxCostCents: num(v) });
                    }
                  : undefined
              }
            />
          }
        />
      </Section>
    </div>
  );
}

function OutcomesInspector({
  workflow,
  actions,
}: {
  workflow: Workflow;
  actions?: SkillDraftActions | undefined;
}) {
  return (
    <div>
      <InspectorHeader
        icon="flag"
        kind="Outcomes"
        title="Pass / fail criteria"
        accent={ACCENT_GOAL}
      />
      {workflow.outcomes.length === 0 && <Empty>No outcomes defined.</Empty>}
      {workflow.outcomes.map((o) => (
        <div
          key={o.id}
          style={{
            marginBottom: 'var(--space-md)',
            padding: 'var(--space-md)',
            background: 'var(--surface-raised-alpha)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-0)',
              marginBottom: 'var(--space-xs)',
            }}
          >
            <Badge variant="info">{o.evaluator.type}</Badge>
            {actions && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  actions.removeOutcome(o.id);
                }}
                style={{ marginLeft: 'auto', color: 'var(--color-error-default, #ef4444)' }}
              >
                <Icon name="trash" size="xs" />
              </Button>
            )}
          </div>
          <Editable
            value={o.name}
            onChange={
              actions
                ? (v) => {
                    actions.patchOutcome(o.id, { name: v });
                  }
                : undefined
            }
          />
          <div style={{ marginTop: 'var(--space-sm)' }}>
            {actions ? (
              <EvaluatorEditor outcome={o} actions={actions} />
            ) : (
              evaluatorDetail(o.evaluator)
            )}
          </div>
        </div>
      ))}
      {actions && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            actions.addOutcome();
          }}
        >
          <Icon name="plus" size="xs" /> Add outcome
        </Button>
      )}
    </div>
  );
}

function fieldTypeOf(schema: CampaignContractField['schema']): 'string' | 'number' | 'boolean' {
  const t = (schema as { type?: unknown }).type;
  return t === 'number' || t === 'boolean' ? t : 'string';
}
function schemaForType(t: string): Record<string, unknown> {
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  return { type: 'string', minLength: 1 };
}

/** A field key or label is invalid, or a goal field is blank — block the save. */
function isManifestInvalid(draft: UseManifestDraft): boolean {
  const contractBad = Object.entries(draft.contract?.fields ?? {}).some(
    ([k, f]) => !FIELD_KEY_RE.test(k) || !f.label.trim(),
  );
  const g = draft.goal;
  const goalBad =
    (g?.type === 'numeric' && !g.metricKey.trim()) ||
    (g?.type === 'subjective' &&
      (g.rubric.length === 0 ||
        g.rubric.length > 20 ||
        g.rubric.some((r) => !r.trim() || r.length > 1000)));
  return contractBad || goalBad;
}

function ManifestSaveBar({ draft }: { draft: UseManifestDraft }) {
  const invalid = isManifestInvalid(draft);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) var(--space-md)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-1)',
        flexWrap: 'wrap',
        marginBottom: 'var(--space-md)',
      }}
    >
      <Icon name="bullseye" size="xs" color="var(--color-info-default)" />
      <Text size="sm" weight="semibold">
        Goal / contract changed
      </Text>
      {draft.saveError && (
        <Text size="xs" tone="danger" truncate style={{ maxWidth: 220 }}>
          {draft.saveError}
        </Text>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-xs)' }}>
        <Button variant="ghost" size="sm" onClick={draft.discard} disabled={draft.saving}>
          Discard
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void draft.save()}
          disabled={draft.saving || invalid}
        >
          {draft.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function ContractFieldRow({
  fieldKey,
  field,
  actions,
  identityLocked,
}: {
  fieldKey: string;
  field: CampaignContractField;
  actions: ContractDraftActions;
  /** A campaign is active — identity is frozen for its life. */
  identityLocked: boolean;
}) {
  const identity = field.identity === true;
  const lockThis = identityLocked && identity;
  // Buffer the key locally and commit on blur — renaming the draft map key on
  // every keystroke would remount the row (it is the React list key) and drop
  // focus. The buffer also lets us validate before writing the draft.
  const [keyBuf, setKeyBuf] = useState(fieldKey);
  const keyValid = FIELD_KEY_RE.test(keyBuf);
  const labelValid = field.label.trim().length > 0;

  const commitKey = () => {
    if (keyBuf === fieldKey) return;
    if (keyValid) actions.renameField(fieldKey, keyBuf);
    else setKeyBuf(fieldKey);
  };

  return (
    <div
      style={{
        marginBottom: 'var(--space-md)',
        padding: 'var(--space-md)',
        background: 'var(--surface-raised-alpha)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--space-xs)', alignItems: 'center' }}>
        <Input
          value={keyBuf}
          onChange={(e) => {
            setKeyBuf(e.target.value);
          }}
          onBlur={commitKey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitKey();
          }}
          placeholder="field_key"
          disabled={lockThis}
          aria-label="Campaign field key"
          error={!keyValid}
          style={{ flex: 1, fontFamily: 'var(--font-family-mono, monospace)' }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            actions.removeField(fieldKey);
          }}
          disabled={lockThis}
        >
          <Icon name="trash" size="xs" />
        </Button>
      </div>
      {!keyValid && (
        <Text size="xs" tone="danger">
          Keys must start with a letter and use only letters, digits, or underscores.
        </Text>
      )}
      <Field label="Label" {...(labelValid ? {} : { error: 'Required' })}>
        <Input
          value={field.label}
          aria-label="Campaign field label"
          error={!labelValid}
          onChange={(e) => {
            actions.patchField(fieldKey, { label: e.target.value });
          }}
        />
      </Field>
      <Field label="Type">
        <Select
          value={fieldTypeOf(field.schema)}
          aria-label="Campaign field type"
          onChange={(e) => {
            actions.patchField(fieldKey, { schema: schemaForType(e.target.value) });
          }}
          disabled={lockThis}
        >
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="boolean">boolean</option>
        </Select>
      </Field>
      <div style={{ display: 'flex', gap: 'var(--space-md)', marginTop: 'var(--space-xs)' }}>
        <Checkbox
          checked={identity}
          disabled={identityLocked}
          onChange={(e) => {
            actions.patchField(
              fieldKey,
              // Demoting from identity restores the mutable-by-default state
              // (otherwise the `mutable: false` set on promotion would linger).
              e.target.checked
                ? { identity: true, mutable: false }
                : { identity: false, mutable: true },
            );
          }}
          label="Identity"
        />
        <Checkbox
          checked={!identity && field.mutable !== false}
          disabled={identity}
          onChange={(e) => {
            actions.patchField(fieldKey, { mutable: e.target.checked });
          }}
          label="Mutable"
        />
      </div>
    </div>
  );
}

function CampaignInspector({
  draft,
  savedContract,
  hasActiveCampaign,
  spaceId,
  slug,
}: {
  draft: UseManifestDraft;
  /** The persisted contract — what a started campaign uses (not the live edit). */
  savedContract?: SkillCampaignContract | undefined;
  hasActiveCampaign: boolean;
  spaceId: string;
  slug: string;
}) {
  const [startOpen, setStartOpen] = useState(false);
  const fields = Object.entries(draft.contract?.fields ?? {});

  return (
    <div>
      <InspectorHeader
        icon="sliders"
        kind="Campaign"
        title="Run-to-run parameters"
        accent="var(--color-info-default)"
      />
      {draft.dirty && <ManifestSaveBar draft={draft} />}
      <Text size="sm" color="muted" style={{ marginBottom: 'var(--space-md)' }}>
        Fields a campaign supplies per run — `$campaign` refs on the goal, eval thresholds, and
        outcome bars resolve against these. Identity fields fix a campaign&apos;s identity; mutable
        fields can change mid-campaign.
      </Text>
      {hasActiveCampaign && (
        <Text
          size="xs"
          tone="warning"
          style={{
            display: 'block',
            marginBottom: 'var(--space-md)',
            padding: 'var(--space-sm)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-warning-soft, var(--color-surface-2))',
          }}
        >
          A campaign is active — identity fields are frozen for its life. End it to change identity.
        </Text>
      )}

      <div style={{ display: 'flex', gap: 'var(--space-xs)', marginBottom: 'var(--space-md)' }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            draft.contractActions.addField();
          }}
        >
          <Icon name="plus" size="xs" /> Add field
        </Button>
        {savedContract && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStartOpen(true);
            }}
            disabled={draft.dirty}
          >
            Start campaign
          </Button>
        )}
      </div>

      {fields.length === 0 && (
        <Empty>No campaign fields. Add one, or leave empty for a config-less skill.</Empty>
      )}
      {fields.map(([key, field]) => (
        <ContractFieldRow
          key={key}
          fieldKey={key}
          field={field}
          actions={draft.contractActions}
          identityLocked={hasActiveCampaign}
        />
      ))}

      {savedContract && (
        <CampaignFormDialog
          open={startOpen}
          onClose={() => {
            setStartOpen(false);
          }}
          spaceId={spaceId}
          workflowSlug={slug}
          contract={savedContract}
          mode="start"
        />
      )}
    </div>
  );
}

function TaskInspector({
  task,
  workflow,
  diags,
  actions,
  modelOptions,
  spaceId,
  taskCriteria,
  onRemoveCriterion,
  onAddCriterion,
}: {
  task: WorkflowTask;
  workflow: Workflow;
  diags: SkillDiagnostic[];
  actions?: SkillDraftActions | undefined;
  modelOptions: SelectOption[];
  spaceId: string;
  taskCriteria: EvalCriterion[];
  onRemoveCriterion?: ((name: string) => void) | undefined;
  onAddCriterion?: ((c: EvalCriterion) => void) | undefined;
}) {
  const dispatch = inferTaskType(task);
  const accent =
    dispatch === 'agent'
      ? 'var(--color-interactive-default)'
      : dispatch === 'operation'
        ? 'var(--color-warning-default)'
        : 'var(--color-info-default)';
  const icon: IconName =
    dispatch === 'agent' ? 'robot' : dispatch === 'operation' ? 'lightning' : 'user';
  const caps = task.context?.capabilities;
  const bindings = task.inputBindings ? Object.entries(task.inputBindings) : [];
  const patch = (p: Partial<WorkflowTask>) => actions?.patchTask(task.taskId, p);

  // Model selector options: a "default" entry, the catalog, and the current
  // value if it is not in the catalog (so an unusual model is never dropped).
  const modelSelect: SelectOption[] = [{ value: '', label: 'Default model' }, ...modelOptions];
  if (task.model && !modelSelect.some((o) => o.value === task.model)) {
    modelSelect.push({ value: task.model, label: task.model });
  }

  return (
    <div>
      <InspectorHeader
        icon={icon}
        kind={dispatch}
        title={task.name}
        accent={accent}
        onRemove={
          actions
            ? () => {
                actions.removeTask(task.taskId);
              }
            : undefined
        }
      />

      {diags.length > 0 && (
        <Section label="Issues">
          {diags.map((d, i) => (
            <DiagRow key={i} d={d} />
          ))}
        </Section>
      )}

      <Section label="Name">
        <Editable value={task.name} onChange={actions ? (v) => patch({ name: v }) : undefined} />
      </Section>
      <Section label="Goal">
        <Editable
          value={task.goal}
          multiline
          onChange={actions ? (v) => patch({ goal: v }) : undefined}
        />
      </Section>

      <Section label="Dispatch">
        {actions && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
            }}
          >
            <Text size="sm" color="muted">
              Type
            </Text>
            <Sel
              value={dispatch}
              options={DISPATCH_OPTIONS}
              width={170}
              onChange={(v) => {
                actions.setDispatch(task.taskId, v as 'agent' | 'operation' | 'human');
              }}
            />
          </div>
        )}
        {dispatch === 'agent' && (
          <KV
            k="Agent"
            v={
              <Editable
                value={task.agent ?? workflow.assignedAgent ?? 'cybernetic-runner'}
                onChange={actions ? (v) => patch({ agent: v }) : undefined}
              />
            }
          />
        )}
        {dispatch === 'operation' && (
          <KV
            k="Operation"
            v={
              <Editable
                value={task.operation ?? ''}
                placeholder="stepType.group.verb"
                onChange={actions ? (v) => patch({ operation: v }) : undefined}
              />
            }
          />
        )}
        {dispatch === 'human' && (
          <>
            <KV
              k="Intent"
              v={
                <Sel
                  value={task.intent ?? 'collect'}
                  width={120}
                  options={[
                    { value: 'collect', label: 'collect' },
                    { value: 'approve', label: 'approve' },
                  ]}
                  onChange={
                    actions ? (v) => patch({ intent: v as 'collect' | 'approve' }) : undefined
                  }
                />
              }
            />
            {(actions || task.pauseInstruction) && (
              <div style={{ marginTop: 'var(--space-xs)' }}>
                <Editable
                  value={task.pauseInstruction ?? ''}
                  multiline
                  placeholder="What to ask the operator"
                  onChange={actions ? (v) => patch({ pauseInstruction: v }) : undefined}
                />
              </div>
            )}
          </>
        )}
        {/* model is agent-only; maxAttempts is the real retry budget — the
            runtime ignores retryCount and defaults maxAttempts to 3. */}
        {dispatch === 'agent' && (
          <KV
            k="Model"
            v={
              <Sel
                value={task.model ?? ''}
                options={modelSelect}
                onChange={
                  actions ? (v) => patch(v ? { model: v } : { model: undefined }) : undefined
                }
              />
            }
          />
        )}
        {(dispatch === 'agent' || dispatch === 'operation') && (
          <KV
            k="Max attempts"
            v={
              <Editable
                value={task.maxAttempts != null ? String(task.maxAttempts) : ''}
                type="number"
                placeholder="3 (default)"
                onChange={
                  actions
                    ? (v) =>
                        patch({
                          maxAttempts:
                            v.trim() === '' ? undefined : Math.max(1, Math.min(10, Number(v) || 1)),
                        })
                    : undefined
                }
              />
            }
          />
        )}
        {actions ? (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '6px 0',
            }}
          >
            <Text size="sm" color="muted">
              Optional
            </Text>
            <Sel
              value={task.optional ? 'yes' : 'no'}
              options={[
                { value: 'no', label: 'no' },
                { value: 'yes', label: 'yes' },
              ]}
              width={90}
              onChange={(v) => patch({ optional: v === 'yes' })}
            />
          </div>
        ) : (
          <KV k="Optional" v={task.optional ? 'yes' : 'no'} />
        )}
      </Section>

      <Section label="Depends on">
        {(task.dependsOn ?? []).length === 0 ? (
          <Empty>Entry task (no upstream).</Empty>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' }}>
            {task.dependsOn!.map((dep) => (
              <span
                key={dep}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  background: 'var(--color-surface-2)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <Text size="sm">{dep}</Text>
                {actions && (
                  <button
                    type="button"
                    onClick={() => {
                      actions.removeDependency(dep, task.taskId);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--color-text-muted)',
                      display: 'inline-flex',
                    }}
                    title="Remove dependency"
                  >
                    <Icon name="x" size="xs" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </Section>

      {task.when &&
        (() => {
          const view = workflowWhenView(task.when);
          return (
            <Section label="Condition">
              <KV
                k={
                  view.mode === 'all' ? 'when all of' : view.mode === 'any' ? 'when any of' : 'when'
                }
                v={
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {view.clauses.map((clause) => (
                      <Mono key={clause}>{clause}</Mono>
                    ))}
                  </span>
                }
              />
              <KV
                k="On missing ref"
                v={view.onMissingRef === 'error' ? 'fail the run' : 'skip this task'}
              />
            </Section>
          );
        })()}

      {/* Capabilities are the Runner's tool palette — only an agent task uses
          them; operation tasks run one fixed op, human tasks just pause. */}
      {dispatch === 'agent' && (
        <Section label="Capabilities">
          {actions ? (
            <CapabilitiesEditor task={task} actions={actions} spaceId={spaceId} />
          ) : !caps ||
            ((caps.integrations?.length ?? 0) === 0 && (caps.operations?.length ?? 0) === 0) ? (
            <Empty>No capabilities granted.</Empty>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' }}>
              {caps.integrations?.map((ig, i) => (
                <Badge key={`i-${i}`} variant="neutral" icon={<Icon name="plugs" size="xs" />}>
                  {ig.integrationId ?? ig.capabilityId}
                  {ig.sourceKind ? ` (${ig.sourceKind})` : ''}
                </Badge>
              ))}
              {caps.operations?.map((op) => (
                <Badge key={op} variant="neutral" icon={<Icon name="lightning" size="xs" />}>
                  {op}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}

      <Section label="Consumes">
        {actions ? (
          <ConsumesEditor workflow={workflow} task={task} actions={actions} />
        ) : bindings.length === 0 ? (
          <Empty>No input bindings.</Empty>
        ) : (
          bindings.map(([name, b]) => (
            <KV key={name} k={name} v={<Mono>{bindingSummary(b)}</Mono>} />
          ))
        )}
      </Section>

      <Section label="Produces">
        {actions ? (
          <ProducesEditor workflow={workflow} task={task} actions={actions} />
        ) : (
          (() => {
            const outputs = deriveTaskOutputs(workflow, task.taskId);
            if (outputs.length === 0) return <Empty>No outputs.</Empty>;
            return outputs.map((o) => (
              <KV
                key={o.key}
                k={o.key}
                v={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Badge variant="neutral">{o.semantics}</Badge>
                    {o.derived && (
                      <Text size="xs" color="muted" style={{ fontStyle: 'italic' }}>
                        inferred
                      </Text>
                    )}
                  </span>
                }
              />
            ));
          })()
        )}
      </Section>

      <EvalCriteriaSection
        label="Verified"
        criteria={taskCriteria}
        onRemove={onRemoveCriterion}
        onAdd={onAddCriterion}
      />
    </div>
  );
}
