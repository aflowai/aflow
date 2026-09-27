import { describe, it, expect } from 'vitest';
import { StepOutputPresentationSchema } from './stepPresentation.js';
import { WorkflowRunDetailInputSchema } from '../operations/workflow/runDetail.js';

const RUN_ID = '11111111-2222-3333-4444-555555555555';

describe('StepOutputPresentation — workflow_run substrate', () => {
  it('round-trips the workflow_run rendered_inline hint', () => {
    const parsed = StepOutputPresentationSchema.parse({
      mode: 'rendered_inline',
      substrate: 'workflow_run',
      runId: RUN_ID,
    });
    expect(parsed).toEqual({ mode: 'rendered_inline', substrate: 'workflow_run', runId: RUN_ID });
  });

  it('rejects a non-uuid runId', () => {
    expect(() =>
      StepOutputPresentationSchema.parse({
        mode: 'rendered_inline',
        substrate: 'workflow_run',
        runId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('round-trips the applet rendered_inline hint', () => {
    const parsed = StepOutputPresentationSchema.parse({
      mode: 'rendered_inline',
      substrate: 'applet',
      instanceId: RUN_ID,
    });
    expect(parsed).toEqual({
      mode: 'rendered_inline',
      substrate: 'applet',
      instanceId: RUN_ID,
    });
  });

  it('rejects an applet hint without an instanceId', () => {
    expect(() =>
      StepOutputPresentationSchema.parse({
        mode: 'rendered_inline',
        substrate: 'applet',
      }),
    ).toThrow();
  });

  it('rejects a non-uuid applet instanceId', () => {
    expect(() =>
      StepOutputPresentationSchema.parse({
        mode: 'rendered_inline',
        substrate: 'applet',
        instanceId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('still accepts the artifact + surface substrates', () => {
    expect(
      StepOutputPresentationSchema.parse({
        mode: 'rendered_inline',
        substrate: 'surface',
        surfaceId: 's1',
      }).substrate,
    ).toBe('surface');
    expect(StepOutputPresentationSchema.parse({ mode: 'summarize' }).mode).toBe('summarize');
  });
});

describe('WorkflowRunDetailInput — present flag', () => {
  it('accepts present: true (opt-in inline render)', () => {
    expect(WorkflowRunDetailInputSchema.parse({ runId: RUN_ID, present: true }).present).toBe(true);
  });

  it('present is optional (bare observation call)', () => {
    expect(WorkflowRunDetailInputSchema.parse({ runId: RUN_ID }).present).toBeUndefined();
  });
});
