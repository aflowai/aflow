import { describe, it, expect } from 'vitest';
import { DurableWorkflowHumanTaskHydrationSchema } from '@aflow/schemas';
import { buildDurableHydration, encodeInlineHydrationRef } from './workflowHumanTaskHydration.js';

const baseResumeContract = {
  pauseCause: 'needs_decision' as const,
  resumePrompt: 'Approve the submission',
  allowedResumeModes: ['replace_output'],
} as never;

describe('buildDurableHydration', () => {
  it('stamps hydrationVersion=1 and ISO createdAt', () => {
    const h = buildDurableHydration({
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: 'approve-submit',
      attempt: 1,
      pauseVersion: 2,
      humanIntent: 'approve',
      resumeContract: baseResumeContract,
    });
    expect(h.hydrationVersion).toBe(1);
    expect(h.runId).toBe('00000000-0000-4000-8000-000000000001');
    expect(h.taskId).toBe('approve-submit');
    expect(h.attempt).toBe(1);
    expect(h.pauseVersion).toBe(2);
    expect(h.humanIntent).toBe('approve');
    expect(() => new Date(h.createdAt)).not.toThrow();
  });

  it('round-trips through Zod', () => {
    const h = buildDurableHydration({
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: 'collect-input',
      attempt: 2,
      pauseVersion: 3,
      humanIntent: 'collect',
      resolutionSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      failureMode: 'cancel_siblings',
      resumeContract: baseResumeContract,
    });
    const parsed = DurableWorkflowHumanTaskHydrationSchema.safeParse(h);
    expect(parsed.success).toBe(true);
  });

  it('omits optional fields cleanly when not supplied', () => {
    const h = buildDurableHydration({
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: 'minimal',
      attempt: 1,
      pauseVersion: 1,
      humanIntent: 'collect',
      resumeContract: baseResumeContract,
    });
    expect('failureMode' in h).toBe(false);
    expect('resolutionSchema' in h).toBe(false);
    expect('actionPreview' in h).toBe(false);
    expect('actionPreviewRef' in h).toBe(false);
  });

  it('includes actionPreview when provided', () => {
    const h = buildDurableHydration({
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: 'approve-submit',
      attempt: 1,
      pauseVersion: 1,
      humanIntent: 'approve',
      actionPreview: {
        op: 'kaggle.submit',
        input: { filePath: '/tmp/submission.csv', message: 'test run' },
      },
      resumeContract: baseResumeContract,
    });
    expect(h.actionPreview?.op).toBe('kaggle.submit');
  });
});

describe('encodeInlineHydrationRef', () => {
  it('produces a valid inline:<base64> ref that decodes back to the same payload', () => {
    const h = buildDurableHydration({
      runId: '00000000-0000-4000-8000-000000000001',
      taskId: 'approve-submit',
      attempt: 1,
      pauseVersion: 2,
      humanIntent: 'approve',
      resumeContract: baseResumeContract,
    });
    const ref = encodeInlineHydrationRef(h);
    expect(ref.startsWith('inline:')).toBe(true);

    const base64 = ref.slice('inline:'.length);
    const decoded = JSON.parse(Buffer.from(base64, 'base64').toString('utf8')) as unknown;
    const parsed = DurableWorkflowHumanTaskHydrationSchema.safeParse(decoded);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.runId).toBe(h.runId);
      expect(parsed.data.taskId).toBe(h.taskId);
      expect(parsed.data.pauseVersion).toBe(2);
    }
  });
});
