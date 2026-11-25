import { describe, expect, it } from 'vitest';
import { dryRunWriteDisposition } from '../../catalog/dryRunHold.js';
import { getAllOperations, getOperation } from '../../catalog/registry.js';
import { requiresWriteApproval } from '../../models/apiDefinition.js';
import {
  buildDryRunHeldOutput,
  DRY_RUN_HELD_MESSAGE,
  DryRunHeldOutputSchema,
  WRITE_HOLD_EVERY_TIER,
} from '../dryRun.js';
import { WorkflowRunStartInputSchema } from '../../operations/workflow/runStart.js';
import { StepResultMessageSchema } from '../streamMessages.js';

describe('dryRunWriteDisposition', () => {
  it('holds every platform write a trading cycle can ask for', () => {
    for (const operationId of [
      'memory.store.put',
      'memory.store.patch',
      'memory.store.delete',
      'memory.store.mkdir',
      'workflow.campaign.start',
      'workflow.campaign.update',
      'workflow.campaign.end',
      'workflow.learn',
      'learner.learning.record',
      'mcp.tool.call',
    ]) {
      expect(dryRunWriteDisposition(operationId), operationId).toBe('hold');
    }
  });

  it('leaves API calls to the executor, which reads the endpoint tier', () => {
    expect(dryRunWriteDisposition('api.http.call')).toBe('endpoint');
    expect(dryRunWriteDisposition('api.http.download')).toBe('endpoint');
  });

  it('runs reads, model calls and the run machinery for real', () => {
    for (const operationId of [
      'memory.store.get',
      'memory.store.query',
      'workflow.run.decide',
      'workflow.run.derive',
      'workflow.run.detail',
      'ai.agent.turn',
      'agent.control.submit_output',
      'agent.control.signal_blocked',
      'agent.control.draft_patch',
      'workflow.run.start',
    ]) {
      expect(dryRunWriteDisposition(operationId), operationId).toBe('run');
    }
  });

  it('holds a resume, which moves another session that carries no dryRunOf', () => {
    expect(getOperation('agent.control.resume')).toBeDefined();
    expect(dryRunWriteDisposition('agent.control.resume')).toBe('hold');
  });

  it('holds an operation the registry does not know, so the hold fails closed', () => {
    expect(dryRunWriteDisposition('memory.store.teleport')).toBe('hold');
  });

  it('runs no registered write-mode or mutating operation outside the machinery it names', () => {
    const ran = [...getAllOperations().values()]
      .filter((op) => op.accessMode === 'write' || op.mutates)
      .map((op) => op.operationId)
      .filter((id) => dryRunWriteDisposition(id) === 'run')
      .sort();
    expect(ran.every((id) => /^(ai|agent\.control)\./.test(id) || MACHINERY.has(id))).toBe(true);
  });
});

const MACHINERY = new Set([
  'human.chat.ask',
  'user.interaction.ask',
  'user.interaction.approve',
  'catalog.tool.promote',
  'mcp.tool.promote',
  'ui.surface.visualize',
  'workflow.run.start',
]);

describe('the dry-run write hold', () => {
  it('holds every API write tier the rehearsal holds, and no read', () => {
    expect(requiresWriteApproval('read', WRITE_HOLD_EVERY_TIER)).toBe(false);
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(requiresWriteApproval(tier, WRITE_HOLD_EVERY_TIER)).toBe(true);
    }
  });

  it('returns a held result that names the write and echoes its address', () => {
    const output = buildDryRunHeldOutput(
      {
        runId: 'run-1',
        operationId: 'memory.store.put',
        target: 'memory.store.put /portfolio/cycles/2026-11-24-open.json',
        preview: '{"path":"/portfolio/cycles/2026-11-24-open.json"}',
      },
      { path: '/portfolio/cycles/2026-11-24-open.json' },
    );
    expect(DryRunHeldOutputSchema.parse(output)).toEqual({
      path: '/portfolio/cycles/2026-11-24-open.json',
      dryRun: true,
      held: true,
      operationId: 'memory.store.put',
      target: 'memory.store.put /portfolio/cycles/2026-11-24-open.json',
      wouldWrite: '{"path":"/portfolio/cycles/2026-11-24-open.json"}',
      message: DRY_RUN_HELD_MESSAGE,
    });
  });

  it('lets an echoed field never overwrite the held markers', () => {
    const output = buildDryRunHeldOutput(
      { runId: 'run-1', operationId: 'memory.store.put', target: 't' },
      { held: false, dryRun: false },
    );
    expect(output.held).toBe(true);
    expect(output.dryRun).toBe(true);
  });

  it('rides a step result message', () => {
    const parsed = StepResultMessageSchema.parse({
      messageVersion: 1,
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      sessionId: '44444444-4444-4444-9444-444444444444',
      stepExecutionId: '55555555-5555-4555-9555-555555555555',
      stepId: 'put',
      stepType: 'memory',
      operationId: 'memory.store.put',
      attempt: 1,
      idempotencyKey: 'k',
      status: 'SUCCEEDED',
      outputRef: `inline:${Buffer.from('{}').toString('base64')}`,
      heldWrite: { runId: 'run-1', operationId: 'memory.store.put', target: 't' },
      traceId: 'trace',
      finishedAtMs: 1,
    });
    expect(parsed.heldWrite?.runId).toBe('run-1');
  });

  it('is off unless the run start asks for it', () => {
    expect(WorkflowRunStartInputSchema.parse({ slug: 'daily-trading-cycle' }).dryRun).toBe(false);
    expect(
      WorkflowRunStartInputSchema.parse({ slug: 'daily-trading-cycle', dryRun: true }).dryRun,
    ).toBe(true);
  });
});
