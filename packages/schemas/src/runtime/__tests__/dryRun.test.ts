import { describe, expect, it } from 'vitest';
import { dryRunHoldsHarnessRun, dryRunWriteDisposition } from '../../catalog/dryRunHold.js';
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

  it('leaves an API call to the executor, which reads the endpoint tier and saveTo', () => {
    expect(dryRunWriteDisposition('api.http.call')).toBe('endpoint');
  });

  it('holds a download, which always saves its response as a memory document', () => {
    expect(getOperation('api.http.download')).toBeDefined();
    expect(dryRunWriteDisposition('api.http.download')).toBe('hold');
  });

  it('holds every ai media operation, which stores its output as a memory document', () => {
    const media = [...getAllOperations().keys()].filter((id) => id.startsWith('ai.media.'));
    expect(media.sort()).toEqual([
      'ai.media.animate',
      'ai.media.edit_image',
      'ai.media.image',
      'ai.media.video',
    ]);
    for (const operationId of media) {
      expect(dryRunWriteDisposition(operationId), operationId).toBe('hold');
    }
  });

  it('runs the ai model calls, which the registry marks as reads', () => {
    for (const operationId of [
      'ai.text.generate',
      'ai.text.generate_json',
      'ai.text.generate_stream',
      'ai.embedding.generate',
      'ai.decision.decide',
      'ai.model.probe_reasoning',
    ]) {
      expect(dryRunWriteDisposition(operationId), operationId).toBe('run');
    }
  });

  it('holds an unregistered operation under a machinery group', () => {
    expect(dryRunWriteDisposition('ai.media.teleport')).toBe('hold');
    expect(dryRunWriteDisposition('agent.control.teleport')).toBe('hold');
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

  it('runs a harness run, whose agent and model work is what a dry run proves', () => {
    expect(getOperation('host.harness.run')).toBeDefined();
    expect(dryRunWriteDisposition('host.harness.run')).toBe('harness');
    expect(dryRunHoldsHarnessRun({ bindingId: 'hb_desk', task: 'Propose candidates.' })).toBe(
      false,
    );
  });

  it('holds a harness run that asks for a browser, and an input it cannot read', () => {
    expect(
      dryRunHoldsHarnessRun({ bindingId: 'hb_desk', task: 'x', browser: { profile: 'ephemeral' } }),
    ).toBe(true);
    expect(dryRunHoldsHarnessRun(null)).toBe(true);
    expect(dryRunHoldsHarnessRun('{"bindingId":"hb_desk"}')).toBe(true);
  });

  it('decides from the input for the harness run alone', () => {
    const harness = [...getAllOperations().keys()].filter(
      (id) => dryRunWriteDisposition(id) === 'harness',
    );
    expect(harness).toEqual(['host.harness.run']);
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
    expect(ran.filter((id) => !MACHINERY.has(id))).toEqual([]);
  });
});

const MACHINERY = new Set([
  'ai.agent.turn',
  'agent.control.dispatch',
  'agent.control.delegate',
  'agent.control.abort',
  'agent.control.end',
  'agent.control.run_step',
  'agent.control.draft_patch',
  'agent.control.draft_get',
  'agent.control.submit_output',
  'agent.control.signal_blocked',
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
