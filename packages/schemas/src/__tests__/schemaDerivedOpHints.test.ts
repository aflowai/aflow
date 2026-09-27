import { describe, it, expect } from 'vitest';
import {
  describeStagedChangeOpKinds,
  listStagedChangeOpKinds,
  renderStagedChangeOpHints,
} from '../cybernetic/schemaDerivedOpHints.js';

describe('listStagedChangeOpKinds', () => {
  it('returns the closed set of op discriminator values', () => {
    const kinds = listStagedChangeOpKinds();
    // Spot-check several known kinds — exhaustive list would over-bind.
    expect(kinds).toContain('update_task_goal');
    expect(kinds).toContain('add_task');
    expect(kinds).toContain('remove_task');
    expect(kinds).toContain('flag_pattern');
    expect(kinds).toContain('platform_issue');
    expect(kinds).toContain('block_workflow');
    expect(kinds).toContain('eval.criterion.add');
    expect(kinds).toContain('eval.criterion.remove');
    expect(kinds).toContain('eval.criterion.update');
  });

  it('returns sorted output for deterministic prompt rendering', () => {
    const kinds = listStagedChangeOpKinds();
    const sorted = [...kinds].sort();
    expect(kinds).toEqual(sorted);
  });
});

describe('describeStagedChangeOpKinds', () => {
  it("captures flag_pattern's actual fields (no 'cause' field — Plan 163 §9.3 drift fix)", () => {
    const flag = describeStagedChangeOpKinds().find((c) => c.op === 'flag_pattern');
    expect(flag).toBeDefined();
    const fields = flag!.fields.map((f) => f.field);
    expect(fields).toContain('patternDescription');
    expect(fields).toContain('suggestedScope');
    // Drift fix — the pre-Plan-163 prompt referenced `cause='needs_binding'`
    // which the schema never accepted. The contract should not list it.
    expect(fields).not.toContain('cause');
  });

  it("captures update_task_goal's required fields", () => {
    const op = describeStagedChangeOpKinds().find((c) => c.op === 'update_task_goal');
    expect(op).toBeDefined();
    const required = op!.fields.filter((f) => f.required).map((f) => f.field);
    expect(required).toContain('taskId');
    expect(required).toContain('newGoal');
  });
});

describe('renderStagedChangeOpHints', () => {
  it('renders a markdown block including each requested op', () => {
    const out = renderStagedChangeOpHints(['update_task_goal', 'add_task']);
    expect(out).toContain('### update_task_goal');
    expect(out).toContain('### add_task');
    expect(out).not.toContain('### remove_task');
  });

  it('returns hints for every op when no filter is supplied', () => {
    const out = renderStagedChangeOpHints();
    expect(out).toContain('### flag_pattern');
    expect(out).toContain('### platform_issue');
  });
});
