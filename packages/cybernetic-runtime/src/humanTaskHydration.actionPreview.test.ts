import { describe, it, expect } from 'vitest';
import {
  summarizeActionPreviewInput,
  buildDisplayActionPreview,
  resolveActionPreview,
} from './humanTaskHydration.js';
import type { WorkflowRunContext } from './scheduling/workflowResolver.js';

describe('summarizeActionPreviewInput (Plan 186 §5.D)', () => {
  it('reports size + line count and keeps only the head of a large string input', () => {
    const csv =
      'Id,SalePrice\n' + Array.from({ length: 1000 }, (_, i) => `${i},${i * 100}`).join('\n');
    const stat = summarizeActionPreviewInput(csv);
    expect(stat['__previewTruncated']).toBe(true);
    expect(stat['sizeBytes']).toBe(Buffer.byteLength(csv, 'utf8'));
    expect(stat['lineCount']).toBe(1001);
    const head = stat['head'] as string;
    // Head keeps the first lines only, never the full body.
    expect(head.startsWith('Id,SalePrice')).toBe(true);
    expect(head.split('\n').length).toBeLessThanOrEqual(8);
    expect(head.length).toBeLessThan(csv.length);
  });

  it('summarizes an object input by its serialized size', () => {
    const input = { fileContent: 'x'.repeat(50_000), message: 'submit run 2' };
    const stat = summarizeActionPreviewInput(input);
    expect(stat['__previewTruncated']).toBe(true);
    expect(stat['sizeBytes']).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
    // The full 50 KB payload is never echoed into the stat head.
    expect(JSON.stringify(stat).length).toBeLessThan(2_000);
  });
});

describe('resolveActionPreview — campaign_input (Plan 195 §4.4)', () => {
  function campaignContext(config?: Record<string, unknown>): WorkflowRunContext {
    return {
      taskOutputs: new Map(),
      stateVariables: new Map(),
      ...(config ? { campaignConfig: config } : {}),
    };
  }

  it('resolves a campaign_input binding into the previewed op input', () => {
    const result = resolveActionPreview(
      {
        op: 'mcp.kaggle.submit',
        inputBindings: {
          competitionName: { kind: 'campaign_input', path: 'competitionSlug' },
        },
      },
      campaignContext({ competitionSlug: 'house-prices' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.preview.op).toBe('mcp.kaggle.submit');
      expect((result.preview.input as Record<string, unknown>)['competitionName']).toBe(
        'house-prices',
      );
      // The bindings are materialized away — only the resolved input remains.
      expect(result.preview.inputBindings).toBeUndefined();
    }
  });

  it('fails when no campaign config is available for a campaign_input binding', () => {
    const result = resolveActionPreview(
      {
        op: 'mcp.kaggle.submit',
        inputBindings: {
          competitionName: { kind: 'campaign_input', path: 'competitionSlug' },
        },
      },
      campaignContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Campaign config not available');
  });
});

describe('resolveActionPreview — run_input', () => {
  // An approve task's actionPreview legitimately binds `run_input` (e.g. an
  // op-task preview parameterized by the run's inputs). runContextFromDetail
  // must populate `runInput` so this resolves at approve time — otherwise the
  // approvedCall fails with "Run input not available" and approval is dropped.
  it('resolves a run_input binding into the previewed op input', () => {
    const result = resolveActionPreview(
      {
        op: 'code.agent.run',
        inputBindings: {
          repo: { kind: 'run_input', path: 'repo' },
          branch: { kind: 'run_input', path: 'branch' },
        },
      },
      {
        taskOutputs: new Map(),
        stateVariables: new Map(),
        runInput: { repo: 'munchist/duality', branch: 'agent/x' },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.preview.input as Record<string, unknown>)['repo']).toBe('munchist/duality');
      expect((result.preview.input as Record<string, unknown>)['branch']).toBe('agent/x');
    }
  });

  it('fails when no run_input is available for a run_input binding', () => {
    const result = resolveActionPreview(
      {
        op: 'code.agent.run',
        inputBindings: { repo: { kind: 'run_input', path: 'repo' } },
      },
      { taskOutputs: new Map(), stateVariables: new Map() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Run input not available');
  });
});

describe('buildDisplayActionPreview (Plan 186 §5.D)', () => {
  it('preserves op and replaces input with the head/stat summary', () => {
    const preview = {
      op: 'mcp.kaggle.submit',
      input: { fileContent: 'a,b\n'.repeat(20_000), message: 'go' },
    };
    const display = buildDisplayActionPreview(preview);
    expect(display.op).toBe('mcp.kaggle.submit');
    expect((display.input as Record<string, unknown>)['__previewTruncated']).toBe(true);
    // No inputBindings leak; the display copy is op + summarized input only.
    expect(display.inputBindings).toBeUndefined();
    expect(JSON.stringify(display)).not.toContain('a,b\na,b\na,b');
  });
});
