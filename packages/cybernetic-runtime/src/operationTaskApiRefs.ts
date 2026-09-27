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
    });
  }
  return refs;
}
