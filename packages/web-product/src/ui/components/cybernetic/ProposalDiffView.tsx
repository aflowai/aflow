'use client';

/**
 * Structured diff view for Coach proposal operations.
 *
 * Replaces raw JSON rendering with human-readable change cards per op kind.
 * Covers all 10+ op types from the StagedChangeOp discriminated union.
 *
 * For `skill_compose` ops, delegates to SkillComposePreview for a richer
 * bundle overview (task list, eval summary, activation hints).
 */
import { Badge, Card, CardBody, Column, Row, Text } from '@aflow/design-system';
import { ListingRequirementsSchema } from '@aflow/schemas';
import { listingRequirementRows } from '../../lib/listing-requirements.js';
import { SkillComposePreview } from './SkillComposePreview.js';

interface Op {
  op: string;
  [key: string]: unknown;
}

interface OpDiffEntry {
  field: string;
  before?: string;
  after?: string;
}

interface OpDiff {
  opIndex: number;
  op: string;
  taskId?: string;
  entries: OpDiffEntry[];
}

export interface ProposalDiffViewProps {
  ops: Op[];
  kind: string;
  /** Server-derived before→after entries — keyed by op index. */
  opDiffs?: OpDiff[] | undefined;
}

export function ProposalDiffView({ ops, kind, opDiffs }: ProposalDiffViewProps) {
  if (ops.length === 0) {
    return (
      <Text size="xs" variant="muted">
        No operations in this proposal.
      </Text>
    );
  }

  // skill_compose bundles the entire skill as a single op — use the rich preview.
  if (kind === 'skill_compose') {
    const composeOp = ops.find((o) => o.op === 'skill_compose');
    if (composeOp && typeof composeOp['bundle'] === 'object' && composeOp['bundle'] !== null) {
      return <SkillComposePreview bundle={composeOp['bundle'] as Record<string, unknown>} />;
    }
  }

  return (
    <Column gap="sm">
      <Text size="xs" weight="semibold">
        Operations ({String(ops.length)})
      </Text>
      {ops.map((op, i) => (
        <OpCard key={String(i)} op={op} diff={opDiffs?.find((d) => d.opIndex === i)} />
      ))}
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Per-op rendering
// ---------------------------------------------------------------------------

function OpCard({ op, diff }: { op: Op; diff?: OpDiff | undefined }) {
  // When the server supplied a before→after diff for this op, it replaces the
  // new-values-only render — the operator sees what actually changes.
  const content = diff && diff.entries.length > 0 ? <DiffEntries diff={diff} /> : renderOp(op);
  return (
    <Card>
      <CardBody>
        <Column gap="xs">
          <Row gap="xs" align="center" wrap>
            <Badge variant={opVariant(op.op)}>{opLabel(op.op)}</Badge>
            {opTarget(op) && (
              <Text size="xs" variant="muted">
                {opTarget(op)}
              </Text>
            )}
          </Row>
          {content}
        </Column>
      </CardBody>
    </Card>
  );
}

function DiffEntries({ diff }: { diff: OpDiff }) {
  return (
    <Column gap="xs">
      {diff.taskId && <KV label="Task" value={diff.taskId} />}
      {diff.entries.map((e, i) => (
        <Column key={String(i)} gap="none">
          <Text size="xs" variant="muted">
            {e.field}
          </Text>
          {e.before !== undefined && (
            <Text size="xs" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {'− '}
              {e.before}
            </Text>
          )}
          {e.after !== undefined && (
            <Text size="xs" style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
              {'+ '}
              {e.after}
            </Text>
          )}
        </Column>
      ))}
    </Column>
  );
}

function renderOp(op: Op): React.ReactNode {
  switch (op.op) {
    // -- Task-level ops --
    case 'update_task_goal':
      return (
        <Column gap="xs">
          <KV label="Task" value={str(op['taskId'])} />
          <KV label="New goal" value={str(op['newGoal'])} />
        </Column>
      );

    case 'update_task_context_spec': {
      const spec = op['contextSpec'] as Record<string, unknown> | undefined;
      return (
        <Column gap="xs">
          <KV label="Task" value={str(op['taskId'])} />
          {!!spec?.['strategy'] && <KV label="Strategy" value={str(spec['strategy'])} />}
          {Array.isArray(spec?.['tools']) && (
            <KV label="Tools" value={(spec['tools'] as string[]).join(', ')} />
          )}
        </Column>
      );
    }

    case 'add_task': {
      // `add_task` nests the new task under `op.task` (WorkflowTaskSchema),
      // not flat `op.taskId / op.goal`. The Coach surface uses this view
      // for proposal review; rendering the flat fields shows blank values
      // for every add_task op the operator sees.
      const task =
        op['task'] && typeof op['task'] === 'object'
          ? (op['task'] as Record<string, unknown>)
          : null;
      const deps = task && Array.isArray(task['dependsOn']) ? (task['dependsOn'] as unknown[]) : [];
      return (
        <Column gap="xs">
          <KV label="Task ID" value={str(task?.['taskId'])} />
          {!!task?.['name'] && <KV label="Name" value={str(task['name'])} />}
          <KV label="Goal" value={str(task?.['goal'])} />
          {!!task?.['type'] && <KV label="Type" value={str(task['type'])} />}
          {deps.length > 0 && <KV label="Depends on" value={deps.map((d) => str(d)).join(', ')} />}
          {op['source'] === true && <KV label="Source task" value="yes (no upstream)" />}
        </Column>
      );
    }

    case 'remove_task':
      return <KV label="Remove task" value={str(op['taskId'])} />;

    case 'reorder_tasks': {
      const ids = op['taskIds'];
      return (
        <Column gap="xs">
          <Text size="xs" weight="semibold">
            New order:
          </Text>
          {Array.isArray(ids) &&
            ids.map((id, i) => (
              <Text key={String(i)} size="xs">
                {String(i + 1)}. {str(id)}
              </Text>
            ))}
        </Column>
      );
    }

    // -- Workflow-level ops --
    case 'update_outcome_threshold':
      return (
        <Column gap="xs">
          <KV label="Outcome" value={str(op['outcomeId'])} />
          <KV label="New target" value={String(op['newTarget'])} />
        </Column>
      );

    case 'update_activation_hint':
      return <KV label="New hint" value={str(op['newHint'])} />;

    case 'add_trigger_pattern':
      return <KV label="Pattern" value={str(op['pattern'])} />;

    case 'update_iteration_policy': {
      const fields: Array<[string, unknown]> = [];
      if (op['maxConsecutiveRuns'] !== undefined)
        fields.push(['Max consecutive runs', op['maxConsecutiveRuns']]);
      if (op['cooldownMs'] !== undefined) fields.push(['Cooldown (ms)', op['cooldownMs']]);
      if (op['stopOnOutcomesMet'] !== undefined)
        fields.push(['Stop on outcomes met', op['stopOnOutcomesMet']]);
      return (
        <Column gap="xs">
          {fields.map(([label, value]) => (
            <KV key={label} label={label} value={str(value)} />
          ))}
        </Column>
      );
    }

    case 'promote_context_strategy':
      return (
        <Column gap="xs">
          <KV label="Task" value={str(op['taskId'])} />
          <Row gap="xs" align="center">
            <Badge variant="neutral">{str(op['from'])}</Badge>
            <Text size="xs" variant="muted">
              →
            </Text>
            <Badge variant="info">{str(op['to'])}</Badge>
          </Row>
        </Column>
      );

    // -- Manifest (goal / campaign contract) --
    case 'update_goal':
      return <KV label="New goal" value={str(op['goal'])} />;

    case 'campaign.field.add':
    case 'campaign.field.update':
      return (
        <Column gap="xs">
          <KV label="Field" value={str(op['fieldKey'])} />
          <KV label="Definition" value={str(op['field'])} />
        </Column>
      );

    case 'campaign.field.remove':
      return <KV label="Remove field" value={str(op['fieldKey'])} />;

    // -- Block/unblock --
    case 'block_workflow':
      return <KV label="Reason" value={str(op['reason'])} />;

    case 'unblock_workflow':
      return (
        <Text size="xs" variant="muted">
          Restores workflow to active status.
        </Text>
      );

    // -- Eval criterion ops --
    case 'eval.criterion.add': {
      const crit = op['criterion'] as Record<string, unknown> | undefined;
      return (
        <Column gap="xs">
          <KV label="Skill" value={str(op['skillSlug'])} />
          <KV label="Scope" value={str(op['targetScope'] ?? 'goal')} />
          {!!op['taskId'] && <KV label="Task" value={str(op['taskId'])} />}
          {!!crit?.['name'] && <KV label="Criterion" value={str(crit['name'])} />}
          {!!crit?.['rubric'] && (
            <Text
              size="xs"
              variant="muted"
              style={{ fontStyle: 'italic', maxHeight: 60, overflow: 'hidden' }}
            >
              {str(crit['rubric'])}
            </Text>
          )}
          {!!op['replacedCriterionId'] && (
            <KV label="Replaces" value={str(op['replacedCriterionId'])} />
          )}
          <KV label="Rationale" value={str(op['rationale'])} />
        </Column>
      );
    }

    case 'eval.criterion.remove':
      return (
        <Column gap="xs">
          <KV label="Skill" value={str(op['skillSlug'])} />
          <KV label="Criterion" value={str(op['criterionId'])} />
          <KV label="Rationale" value={str(op['rationale'])} />
        </Column>
      );

    case 'eval.criterion.update': {
      const patch = op['patch'] as Record<string, unknown> | undefined;
      return (
        <Column gap="xs">
          <KV label="Skill" value={str(op['skillSlug'])} />
          <KV label="Criterion" value={str(op['criterionId'])} />
          {patch && (
            <Column gap="xs">
              {Object.entries(patch).map(([k, v]) => (
                <PatchField key={k} label={k} value={v} />
              ))}
            </Column>
          )}
          <KV label="Rationale" value={str(op['rationale'])} />
        </Column>
      );
    }

    // -- Platform / informational --
    case 'platform_issue':
      return (
        <Column gap="xs">
          <KV label="Subject" value={str(op['subjectKind'])} />
          {!!op['subjectId'] && <KV label="ID" value={str(op['subjectId'])} />}
          <KV label="Summary" value={str(op['summary'])} />
        </Column>
      );

    case 'flag_pattern':
      return (
        <Column gap="xs">
          <KV label="Pattern" value={str(op['patternDescription'])} />
          {!!op['suggestedScope'] && (
            <KV label="Suggested scope" value={str(op['suggestedScope'])} />
          )}
        </Column>
      );

    // -- Capability binding --
    case 'capability.definition.upsert': {
      const def = op['definition'] as Record<string, unknown> | undefined;
      const endpoints = Array.isArray(def?.['endpoints']) ? def['endpoints'] : [];
      return (
        <Column gap="xs">
          <KV label="API ID" value={str(op['apiId'])} />
          {!!def?.['name'] && <KV label="Name" value={str(def['name'])} />}
          {!!def?.['baseUrl'] && <KV label="Base URL" value={str(def['baseUrl'])} />}
          {!!def?.['authKind'] && <KV label="Auth" value={str(def['authKind'])} />}
          <KV
            label="Endpoints"
            value={`${String(endpoints.length)} endpoint${endpoints.length === 1 ? '' : 's'}`}
          />
          <KV label="Rationale" value={str(op['rationale'])} />
        </Column>
      );
    }

    case 'capability.binding.remove':
      return (
        <Column gap="xs">
          <KV label="Binding ID" value={str(op['bindingId'])} />
          <KV label="Rationale" value={str(op['rationale'])} />
        </Column>
      );

    // -- Store install --
    case 'store_install': {
      const listing =
        op['listing'] && typeof op['listing'] === 'object'
          ? (op['listing'] as Record<string, unknown>)
          : null;
      const requirements = ListingRequirementsSchema.safeParse(listing?.['requirements']);
      const needs = requirements.success ? listingRequirementRows(requirements.data) : [];
      return (
        <Column gap="xs">
          <KV label="Listing" value={str(listing?.['name'])} />
          <KV label="Kind" value={str(listing?.['kind'])} />
          <KV label="Version" value={str(op['expectedVersion'])} />
          {!!listing?.['tagline'] && (
            <Text size="xs" variant="muted">
              {str(listing['tagline'])}
            </Text>
          )}
          {needs.length > 0 ? (
            <Column gap="xs">
              <Text size="xs" weight="semibold">
                You&apos;ll need:
              </Text>
              {needs.map((row, i) => (
                <Text key={String(i)} size="xs">
                  {row.label}
                </Text>
              ))}
            </Column>
          ) : (
            <KV label="Setup" value="Nothing extra needed" />
          )}
        </Column>
      );
    }

    // -- Directive amendment --
    case 'amend_directives': {
      const paths = op['changedPaths'];
      return (
        <Column gap="xs">
          <Text size="xs" weight="semibold">
            Changed paths:
          </Text>
          {Array.isArray(paths) &&
            paths.map((p, i) => (
              <Badge key={String(i)} variant="neutral">
                {str(p)}
              </Badge>
            ))}
        </Column>
      );
    }

    // Fallback: raw JSON for unknown ops
    default:
      return (
        <pre
          style={{
            fontSize: 11,
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-surface-1)',
            overflow: 'auto',
            maxHeight: 200,
          }}
        >
          {JSON.stringify(op, null, 2)}
        </pre>
      );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function KV({ label, value }: { label: string; value: string }) {
  return (
    <Row gap="sm" align="baseline" style={{ minHeight: 20 }}>
      <Text size="xs" variant="muted" style={{ minWidth: 100, flexShrink: 0 }}>
        {label}
      </Text>
      <Text size="xs" style={{ wordBreak: 'break-word' }}>
        {value}
      </Text>
    </Row>
  );
}

/**
 * Renders one field of a patch object. Plain objects expand into a nested
 * column of sub-fields so an evaluator config like
 *   `{ type: 'judge', name: 'plan-written', rubric: [...] }`
 * is legible inline instead of collapsing to `[object Object]`. Arrays
 * and primitives round-trip through `str()` (JSON for arrays).
 */
function PatchField({ label, value }: { label: string; value: unknown }) {
  const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject) {
    return <KV label={label} value={str(value)} />;
  }
  return (
    <Column gap="xs">
      <Text size="xs" variant="muted" style={{ minWidth: 100, flexShrink: 0 }}>
        {label}
      </Text>
      <Column gap="xs" style={{ marginLeft: 12 }}>
        {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
          <PatchField key={k} label={k} value={v} />
        ))}
      </Column>
    </Column>
  );
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (Array.isArray(v)) return v.map((x) => str(x)).join(', ');
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  if (typeof v === 'function') {
    const name = v.name;
    return name ? `ƒ ${name}()` : 'ƒ ()';
  }
  return '[unknown]';
}

const OP_LABELS: Record<string, string> = {
  update_task_goal: 'Update task goal',
  update_task_context_spec: 'Update context spec',
  add_task: 'Add task',
  remove_task: 'Remove task',
  reorder_tasks: 'Reorder tasks',
  update_outcome_threshold: 'Update outcome',
  update_activation_hint: 'Update activation',
  add_trigger_pattern: 'Add trigger',
  update_iteration_policy: 'Update iteration',
  promote_context_strategy: 'Promote strategy',
  update_goal: 'Update goal',
  'campaign.field.add': 'Add campaign field',
  'campaign.field.update': 'Update campaign field',
  'campaign.field.remove': 'Remove campaign field',
  flag_pattern: 'Flag pattern',
  block_workflow: 'Block workflow',
  unblock_workflow: 'Unblock workflow',
  'eval.criterion.add': 'Add eval criterion',
  'eval.criterion.remove': 'Remove eval criterion',
  'eval.criterion.update': 'Update eval criterion',
  platform_issue: 'Platform issue',
  skill_compose: 'Compose skill',
  'capability.definition.upsert': 'Bind API',
  'capability.binding.remove': 'Remove binding',
  store_install: 'Install from Store',
  amend_directives: 'Amend directives',
};

function opLabel(op: string): string {
  return OP_LABELS[op] ?? op;
}

const DANGER_OPS = new Set([
  'remove_task',
  'block_workflow',
  'eval.criterion.remove',
  'capability.binding.remove',
  'campaign.field.remove',
]);
const INFO_OPS = new Set([
  'add_task',
  'eval.criterion.add',
  'capability.definition.upsert',
  'skill_compose',
  'campaign.field.add',
  'store_install',
]);

function opVariant(op: string): 'danger' | 'info' | 'neutral' {
  if (DANGER_OPS.has(op)) return 'danger';
  if (INFO_OPS.has(op)) return 'info';
  return 'neutral';
}

function opTarget(op: Op): string | null {
  if (op['taskId']) return `task: ${str(op['taskId'])}`;
  if (op['outcomeId']) return `outcome: ${str(op['outcomeId'])}`;
  if (op['skillSlug']) return `skill: ${str(op['skillSlug'])}`;
  if (op['apiId']) return `api: ${str(op['apiId'])}`;
  if (op['bindingId']) return `binding: ${str(op['bindingId'])}`;
  if (op['fieldKey']) return `field: ${str(op['fieldKey'])}`;
  return null;
}
