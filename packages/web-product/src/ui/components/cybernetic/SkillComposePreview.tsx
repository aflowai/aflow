'use client';

/**
 * Rich preview for `skill_compose` proposals.
 *
 * When the Coach (via compose-skill) proposes a new skill bundle, this
 * component renders the full bundle in a structured, readable form so the
 * operator can ratify with confidence — not from raw JSON.
 *
 * Displays: skill header (name, mode, goal), task list with goals,
 * eval suite summary (criteria counts per scope), and activation hints.
 */
import { Badge, Card, CardBody, Column, Row, Text } from '@aflow/design-system';

export interface SkillComposePreviewProps {
  bundle: Record<string, unknown>;
}

export function SkillComposePreview({ bundle }: SkillComposePreviewProps) {
  const workflow = bundle['workflow'] as Record<string, unknown> | undefined;
  const manifest = bundle['manifest'] as Record<string, unknown> | undefined;
  const evalSuite = bundle['evalSuite'] as Record<string, unknown> | undefined;
  const activation = bundle['activation'] as Record<string, unknown> | undefined;
  const rationale = typeof bundle['rationale'] === 'string' ? bundle['rationale'] : null;

  const name = str(manifest?.['name'] ?? workflow?.['name']);
  const mode = str(manifest?.['mode'] ?? workflow?.['mode']);
  const goal =
    manifest?.['goal'] !== undefined ? formatSkillGoal(manifest['goal']) : str(workflow?.['goal']);
  const slug = str(manifest?.['skillId'] ?? workflow?.['slug']);
  const tasks = Array.isArray(workflow?.['tasks']) ? (workflow['tasks'] as TaskLike[]) : [];
  const outcomes = Array.isArray(workflow?.['outcomes'])
    ? (workflow['outcomes'] as OutcomeLike[])
    : [];

  // Eval criteria counts
  const goalCriteria = Array.isArray(evalSuite?.['goalCriteria'])
    ? (evalSuite['goalCriteria'] as unknown[])
    : [];
  const trajCriteria = Array.isArray(evalSuite?.['trajectoryCriteria'])
    ? (evalSuite['trajectoryCriteria'] as unknown[])
    : [];
  const taskCriteriaMap =
    evalSuite?.['taskCriteria'] && typeof evalSuite['taskCriteria'] === 'object'
      ? (evalSuite['taskCriteria'] as Record<string, unknown[]>)
      : {};
  const taskCriteriaCount = Object.values(taskCriteriaMap).reduce(
    (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
    0,
  );

  // Activation
  const triggerPatterns = Array.isArray(activation?.['triggerPatterns'])
    ? (activation['triggerPatterns'] as string[])
    : [];
  const activationHint =
    typeof activation?.['activationHint'] === 'string' ? activation['activationHint'] : null;

  return (
    <Column gap="md">
      <Text size="xs" weight="semibold">
        New Skill Bundle
      </Text>

      {/* Header */}
      <Card>
        <CardBody>
          <Column gap="sm">
            <Row gap="sm" align="center" wrap>
              <Text size="sm" weight="semibold">
                {name}
              </Text>
              <Badge variant="info">{mode}</Badge>
              <Badge variant="neutral">{slug}</Badge>
            </Row>
            <Text size="xs" style={{ fontStyle: 'italic' }}>
              {goal}
            </Text>
            {rationale && (
              <Text size="xs" variant="muted">
                Rationale: {rationale}
              </Text>
            )}
          </Column>
        </CardBody>
      </Card>

      {/* Tasks */}
      {tasks.length > 0 && (
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Text size="xs" weight="semibold">
                  Tasks
                </Text>
                <Badge variant="neutral">{String(tasks.length)}</Badge>
              </Row>
              {tasks.map((t, i) => (
                <Row key={str(t.taskId)} gap="sm" align="baseline">
                  <Text
                    size="xs"
                    variant="muted"
                    style={{ minWidth: 20, textAlign: 'right', flexShrink: 0 }}
                  >
                    {String(i + 1)}.
                  </Text>
                  <Column gap="xs" style={{ flex: 1, minWidth: 0 }}>
                    <Text size="xs" weight="semibold">
                      {str(t.taskId)}
                    </Text>
                    {!!t.goal && (
                      <Text
                        size="xs"
                        variant="muted"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {str(t.goal)}
                      </Text>
                    )}
                  </Column>
                  {!!t.agent && <Badge variant="neutral">agent</Badge>}
                  {!!t.operation && <Badge variant="neutral">operation</Badge>}
                </Row>
              ))}
            </Column>
          </CardBody>
        </Card>
      )}

      {/* Outcomes */}
      {outcomes.length > 0 && (
        <Card>
          <CardBody>
            <Column gap="sm">
              <Row gap="sm" align="center">
                <Text size="xs" weight="semibold">
                  Outcomes
                </Text>
                <Badge variant="neutral">{String(outcomes.length)}</Badge>
              </Row>
              {outcomes.map((o) => (
                <Text key={str(o.id ?? o.name)} size="xs">
                  {str(o.name)}
                </Text>
              ))}
            </Column>
          </CardBody>
        </Card>
      )}

      {/* Eval suite summary */}
      <Card>
        <CardBody>
          <Column gap="sm">
            <Text size="xs" weight="semibold">
              Eval Suite
            </Text>
            <Row gap="sm" wrap>
              <Badge variant="neutral">
                {String(goalCriteria.length)} goal{' '}
                {goalCriteria.length === 1 ? 'criterion' : 'criteria'}
              </Badge>
              {taskCriteriaCount > 0 && (
                <Badge variant="neutral">
                  {String(taskCriteriaCount)} task{' '}
                  {taskCriteriaCount === 1 ? 'criterion' : 'criteria'}
                </Badge>
              )}
              {trajCriteria.length > 0 && (
                <Badge variant="neutral">
                  {String(trajCriteria.length)} trajectory{' '}
                  {trajCriteria.length === 1 ? 'criterion' : 'criteria'}
                </Badge>
              )}
            </Row>
          </Column>
        </CardBody>
      </Card>

      {/* Activation */}
      {(triggerPatterns.length > 0 || activationHint) && (
        <Card>
          <CardBody>
            <Column gap="sm">
              <Text size="xs" weight="semibold">
                Activation
              </Text>
              {activationHint && (
                <Text size="xs" variant="muted">
                  {activationHint}
                </Text>
              )}
              {triggerPatterns.length > 0 && (
                <Row gap="xs" wrap>
                  {triggerPatterns.map((p, i) => (
                    <Badge key={String(i)} variant="info">
                      {p}
                    </Badge>
                  ))}
                </Row>
              )}
            </Column>
          </CardBody>
        </Card>
      )}
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TaskLike {
  taskId?: unknown;
  goal?: unknown;
  agent?: unknown;
  operation?: unknown;
}

interface OutcomeLike {
  id?: unknown;
  name?: unknown;
}

function formatSkillGoal(goal: unknown): string {
  if (typeof goal === 'string') return goal; // legacy / workflow prose goal
  if (!goal || typeof goal !== 'object') return '—';
  const g = goal as Record<string, unknown>;
  if (g['type'] === 'numeric') {
    const dir = g['direction'] === 'minimize' ? 'minimize' : 'maximize';
    const metric = str(g['metricKey']);
    return g['threshold'] !== undefined
      ? `${dir} ${metric} (target ${str(g['threshold'])})`
      : `${dir} ${metric}`;
  }
  if (g['type'] === 'subjective' && Array.isArray(g['rubric'])) {
    return (g['rubric'] as unknown[]).map((r) => str(r)).join('; ');
  }
  if (g['type'] === 'objective' && Array.isArray(g['criteria'])) {
    return (g['criteria'] as Array<Record<string, unknown>>)
      .map((c) => str(c['description'] ?? c['id']))
      .join('; ');
  }
  return str(goal);
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
