import { describe, expect, it } from 'vitest';
import type { RunAccessGrant, Workflow } from '@aflow/schemas';
import { checkWorkflowOperationGrantPreflight } from '../workflowCredentialsPreflight.js';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function makeGrant(allowed: Array<{ capabilityGroupId: string; accessMode: 'read' | 'write' }>) {
  return {
    spaceId: '41be431d-6011-495b-a4f2-6de539a6a0df',
    accessLevel: 'write',
    grantedToUserId: 'c0000000-0000-0000-0000-000000000001',
    tenantRole: 'member',
    spaceRole: 'admin',
    grantedAt: new Date().toISOString(),
    expiresAt: FUTURE,
    capabilities: {
      allowedCapabilities: allowed,
      deniedCapabilities: [],
      allowedRiskModifiers: ['external_side_effect'],
      deniedRiskModifiers: [],
      allowPrivileged: false,
    },
    compiledProfileName: 'Personal Safe',
  } as RunAccessGrant;
}

/** Personal-Safe-shaped: memory + api, no compute.sandbox, no code lane. */
const SAFE_GRANT = makeGrant([
  { capabilityGroupId: 'memory.store', accessMode: 'write' },
  { capabilityGroupId: 'memory.store', accessMode: 'read' },
  { capabilityGroupId: 'memory.run_output', accessMode: 'read' },
  { capabilityGroupId: 'api.http', accessMode: 'write' },
  { capabilityGroupId: 'api.http', accessMode: 'read' },
]);

const FULL_GRANT = makeGrant([
  { capabilityGroupId: 'memory.store', accessMode: 'write' },
  { capabilityGroupId: 'memory.store', accessMode: 'read' },
  { capabilityGroupId: 'compute.sandbox', accessMode: 'write' },
  { capabilityGroupId: 'code.agent', accessMode: 'write' },
]);

function makeWorkflow(
  tasks: Array<{
    taskId: string;
    operation?: string;
    agentOperations?: string[];
    legacyTools?: string[];
  }>,
): Workflow {
  return {
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      ...(t.operation !== undefined ? { operation: t.operation } : {}),
      ...(t.agentOperations !== undefined || t.legacyTools !== undefined
        ? {
            context: {
              ...(t.legacyTools !== undefined ? { tools: t.legacyTools } : {}),
              capabilities: { operations: t.agentOperations ?? [], integrations: [] },
            },
          }
        : {}),
    })),
  } as unknown as Workflow;
}

describe('checkWorkflowOperationGrantPreflight (Plan 302)', () => {
  it('refuses a run whose agent task declares an operation the profile withholds', () => {
    const result = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([
        { taskId: 'prepare', agentOperations: ['memory.store.get'] },
        { taskId: 'execute', agentOperations: ['compute.sandbox.exec', 'memory.store.put'] },
      ]),
    );

    expect(result.ok).toBe(false);
    expect(result.ungrantedOperations).toHaveLength(1);
    expect(result.ungrantedOperations[0]).toMatchObject({
      operationId: 'compute.sandbox.exec',
      consumingTaskIds: ['execute'],
    });
    expect(result.ungrantedOperations[0]?.reason).toContain('compute.sandbox');
  });

  it('passes when the grant covers every declared operation', () => {
    const result = checkWorkflowOperationGrantPreflight(
      FULL_GRANT,
      makeWorkflow([
        { taskId: 'execute', agentOperations: ['compute.sandbox.exec', 'memory.store.get'] },
      ]),
    );
    expect(result.ok).toBe(true);
    expect(result.ungrantedOperations).toHaveLength(0);
  });

  it('checks nothing without a grant — scheduling recompiles before enforcing', () => {
    const result = checkWorkflowOperationGrantPreflight(
      null,
      makeWorkflow([{ taskId: 'execute', agentOperations: ['compute.sandbox.exec'] }]),
    );
    expect(result.ok).toBe(true);
  });

  it('judges an operation task as an op-task call, so opTaskOnly operations pass', () => {
    // code.agent.run is opTaskOnly: as an operation task it is legitimate and
    // only its capability group decides; the same id agent-declared is a
    // contract defect (Plan 190's plane) and is skipped here, not refused.
    const asOpTask = checkWorkflowOperationGrantPreflight(
      FULL_GRANT,
      makeWorkflow([{ taskId: 'implement', operation: 'code.agent.run' }]),
    );
    expect(asOpTask.ok).toBe(true);

    const agentDeclared = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([{ taskId: 'implement', agentOperations: ['code.agent.run'] }]),
    );
    expect(agentDeclared.ok).toBe(true);
  });

  it('refuses an operation task whose capability group the profile withholds', () => {
    const result = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([{ taskId: 'implement', operation: 'code.agent.run' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.ungrantedOperations[0]).toMatchObject({
      operationId: 'code.agent.run',
      consumingTaskIds: ['implement'],
    });
  });

  it('judges operations declared only via the legacy tools field — same toolbox, same filter', () => {
    const result = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([{ taskId: 'execute', legacyTools: ['compute.sandbox.exec'] }]),
    );
    expect(result.ok).toBe(false);
    expect(result.ungrantedOperations[0]).toMatchObject({
      operationId: 'compute.sandbox.exec',
      consumingTaskIds: ['execute'],
    });
  });

  it('ignores ids the registry does not know — they never become tools, so no grant question exists', () => {
    const result = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([
        {
          taskId: 'execute',
          agentOperations: ['definitely.not.an.operation'],
          legacyTools: ['api:some-binding/some_endpoint'],
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it('aggregates consuming tasks per operation instead of repeating the refusal', () => {
    const result = checkWorkflowOperationGrantPreflight(
      SAFE_GRANT,
      makeWorkflow([
        { taskId: 'execute', agentOperations: ['compute.sandbox.exec'] },
        { taskId: 'retrain', agentOperations: ['compute.sandbox.exec'] },
      ]),
    );
    expect(result.ungrantedOperations).toHaveLength(1);
    expect(result.ungrantedOperations[0]?.consumingTaskIds.sort()).toEqual(['execute', 'retrain']);
  });
});
