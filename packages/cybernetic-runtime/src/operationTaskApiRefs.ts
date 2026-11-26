/**
 * Structural minimum shared by a materialized `WorkflowTask` (`operation`) and a
 * compose `TaskGraphDraft` operation task (`operationId`) — so the same collector
 * serves both the runtime readers and the compose-time surface validator.
 */
export interface OperationTaskLike {
  taskId: string;
  operation?: string | undefined;
  operationId?: string | undefined;
  inputTemplate?: unknown;
  optional?: boolean | undefined;
}

/**
 * An API/binding reference carried by an `api.http.call` operation task's
 * `inputTemplate` rather than by `context.capabilities.integrations[]`.
 *
 * Readiness, projection, and proposal validators historically only inspected
 * `context.capabilities` grants, so a binding used solely by a deterministic
 * operation task (the canonical direct-URL upload/download shape) was invisible
 * to "is this skill ready / what does it need" — it ran but never registered as
 * a dependency or a dangling-ref candidate. This collector is
 * the single source those readers fold in so the two reference channels agree.
 */
export interface OperationTaskApiRef {
  taskId: string;
  apiId: string;
  /** Present for direct-URL mode (apiId + bindingId + url). */
  bindingId?: string;
  /** Present for endpoint mode (apiId + endpointId). */
  endpointId?: string;
  /**
   * The task is optional: a run proceeds when it fails, so the binding it
   * calls is not something the skill needs to run. Readiness skips it.
   */
  optional?: true;
}

/**
 * Collect static API references from `api.http.call` operation-task
 * inputTemplates. Only literal string `apiId`/`bindingId`/`endpointId` are
 * collected — a `$bind`/`$ref` node is a runtime value we cannot resolve
 * statically, so those tasks contribute no static reference.
 */
export function collectOperationTaskApiRefs(
  tasks: readonly OperationTaskLike[],
): OperationTaskApiRef[] {
  const refs: OperationTaskApiRef[] = [];
  for (const task of tasks) {
    if ((task.operation ?? task.operationId) !== 'api.http.call') continue;
    const tmpl = task.inputTemplate;
    if (!tmpl || typeof tmpl !== 'object') continue;
    const t = tmpl as Record<string, unknown>;
    const apiId = typeof t['apiId'] === 'string' ? t['apiId'] : undefined;
    if (!apiId) continue;
    const bindingId = typeof t['bindingId'] === 'string' ? t['bindingId'] : undefined;
    const endpointId = typeof t['endpointId'] === 'string' ? t['endpointId'] : undefined;
    refs.push({
      taskId: task.taskId,
      apiId,
      ...(bindingId ? { bindingId } : {}),
      ...(endpointId ? { endpointId } : {}),
      ...(task.optional === true ? { optional: true as const } : {}),
    });
  }
  return refs;
}

/** One skill as an install reads it: its slug and its tasks. */
export interface SkillApiRefSource {
  slug: string;
  tasks: ReadonlyArray<OperationTaskLike & { context?: unknown }>;
}

function grantedApiIds(task: { taskId: string; context?: unknown }): string[] {
  const ctx = task.context as { capabilities?: { integrations?: unknown } } | undefined;
  const integrations = ctx?.capabilities?.integrations;
  if (!Array.isArray(integrations)) return [];
  return integrations.flatMap((grant) => {
    const g = grant as { sourceKind?: unknown; integrationId?: unknown };
    return g.sourceKind === 'api' && typeof g.integrationId === 'string' ? [g.integrationId] : [];
  });
}

/**
 * The activation readiness check an install runs: every API definition a
 * bundle's skills name must resolve in the target space, after the bundle's
 * own definitions are written. An optional task counts too. Readiness skips
 * it, so a dangling definition there fails the task on every run and nothing
 * else says so. Each result is a warning, and the install still lands.
 */
export function danglingApiDefinitionWarnings(
  skills: readonly SkillApiRefSource[],
  resolvableApiIds: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  for (const skill of skills) {
    const missing = new Map<string, Set<string>>();
    const note = (apiId: string, taskId: string) => {
      if (resolvableApiIds.has(apiId)) return;
      const tasks = missing.get(apiId) ?? new Set<string>();
      tasks.add(taskId);
      missing.set(apiId, tasks);
    };
    for (const ref of collectOperationTaskApiRefs(skill.tasks)) note(ref.apiId, ref.taskId);
    for (const task of skill.tasks) {
      for (const apiId of grantedApiIds(task)) note(apiId, task.taskId);
    }
    for (const [apiId, taskIds] of missing) {
      const named = [...taskIds].map((id) => `'${id}'`).join(', ');
      warnings.push(
        `Skill '${skill.slug}' names API definition '${apiId}' in ${named}, and this space holds no definition with that id. ` +
          'Those tasks fail on every run until one is added.',
      );
    }
  }
  return warnings;
}
