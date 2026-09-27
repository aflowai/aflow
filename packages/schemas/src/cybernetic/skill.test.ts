import { describe, it, expect } from 'vitest';
import {
  validateSkillUiOutputShape,
  type SkillUiOutput,
  type SkillUiOutputValidationTask,
} from './skill.js';

function mkTask(
  taskId: string,
  operation?: string,
  dependsOn?: string[],
  inputBindings?: SkillUiOutputValidationTask['inputBindings'],
): SkillUiOutputValidationTask {
  return {
    taskId,
    ...(operation !== undefined ? { operation } : {}),
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(inputBindings !== undefined ? { inputBindings } : {}),
  };
}

function artifactBinding(bindingId: string, bundleId = 'alpaca-portfolio-companion') {
  return {
    artifactId: { kind: 'artifact_binding', bundleId, bindingId },
  };
}

describe('validateSkillUiOutputShape', () => {
  it('returns no errors when uiOutput is undefined', () => {
    const errors = validateSkillUiOutputShape(undefined, [
      mkTask('write-result', 'memory.store.put'),
    ]);
    expect(errors).toEqual([]);
  });

  it("returns no errors for kind: 'none'", () => {
    const errors = validateSkillUiOutputShape({ kind: 'none' }, [
      mkTask('write-result', 'memory.store.put'),
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts kind: 'artifact' with terminal task calling ui.artifact.render", () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'portfolio-card' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch', 'api.http.call'),
      mkTask('render', 'ui.artifact.render', ['fetch'], artifactBinding('portfolio-card')),
    ]);
    expect(errors).toEqual([]);
  });

  it("accepts kind: 'surface' with terminal task calling ui.surface.visualize", () => {
    const ui: SkillUiOutput = { kind: 'surface' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('aggregate', 'compute.sandbox.exec'),
      mkTask('show', 'ui.surface.visualize', ['aggregate']),
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects kind: 'artifact' when terminal task is not ui.artifact.render", () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'x' };
    const errors = validateSkillUiOutputShape(ui, [mkTask('write', 'memory.store.put')]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('wrong_operation');
    expect(errors[0]?.detail).toMatch(/ui\.artifact\.render/);
  });

  it("rejects kind: 'surface' when terminal task is ui.artifact.render", () => {
    const ui: SkillUiOutput = { kind: 'surface' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('aggregate', 'compute.sandbox.exec'),
      mkTask('render', 'ui.artifact.render', ['aggregate']),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('wrong_operation');
    expect(errors[0]?.detail).toMatch(/ui\.surface\.visualize/);
  });

  it('rejects workflow with no terminal task (cycle)', () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'x' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('a', 'ui.artifact.render', ['b'], artifactBinding('x')),
      mkTask('b', 'ui.artifact.render', ['a'], artifactBinding('x')),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('missing_terminal_task');
  });

  it('rejects workflow with multiple terminal tasks', () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'x' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('start', 'memory.store.get'),
      mkTask('render-a', 'ui.artifact.render', ['start'], artifactBinding('x')),
      mkTask('render-b', 'ui.artifact.render', ['start'], artifactBinding('x')),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('ambiguous_terminal');
    expect(errors[0]?.detail).toMatch(/render-a/);
    expect(errors[0]?.detail).toMatch(/render-b/);
  });

  it('correctly identifies terminal task with a multi-task DAG', () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'card' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch-positions', 'api.http.call'),
      mkTask('fetch-prices', 'api.http.call'),
      mkTask('aggregate', 'compute.sandbox.exec', ['fetch-positions', 'fetch-prices']),
      mkTask('render', 'ui.artifact.render', ['aggregate'], artifactBinding('card')),
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects kind: 'artifact' when terminal task has no inputBindings.artifactId", () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'portfolio-card' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch', 'api.http.call'),
      mkTask('render', 'ui.artifact.render', ['fetch']),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('missing_binding');
    expect(errors[0]?.detail).toMatch(/inputBindings\.artifactId/);
  });

  it("rejects kind: 'artifact' when inputBindings.artifactId has the wrong kind", () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'portfolio-card' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch', 'api.http.call'),
      // Wrong kind — task_output isn't a binding source for artifactId.
      mkTask('render', 'ui.artifact.render', ['fetch'], {
        artifactId: { kind: 'task_output' },
      }),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('missing_binding');
    expect(errors[0]?.detail).toMatch(/kind='task_output'/);
  });

  it("rejects kind: 'artifact' when bindingId on the binding doesn't match the manifest", () => {
    const ui: SkillUiOutput = { kind: 'artifact', bindingId: 'portfolio-card' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch', 'api.http.call'),
      // Typo: portfolio_card vs portfolio-card.
      mkTask('render', 'ui.artifact.render', ['fetch'], artifactBinding('portfolio_card')),
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe('mismatched_binding_id');
    expect(errors[0]?.detail).toMatch(/portfolio-card/);
    expect(errors[0]?.detail).toMatch(/portfolio_card/);
  });

  it("skips the bindingId check for kind: 'surface' (no artifactId binding)", () => {
    // Surface skills generate the surface ad-hoc; there's no artifactId
    // binding to check. The kind='surface' branch must NOT trip on the
    // new validator.
    const ui: SkillUiOutput = { kind: 'surface' };
    const errors = validateSkillUiOutputShape(ui, [
      mkTask('fetch', 'api.http.call'),
      mkTask('show', 'ui.surface.visualize', ['fetch']),
    ]);
    expect(errors).toEqual([]);
  });
});
