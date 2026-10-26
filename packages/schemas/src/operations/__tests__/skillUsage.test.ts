import { describe, expect, it } from 'vitest';
import {
  SkillUsageNextSchema,
  SkillUsageSchema,
  WorkflowGetOutputSchema,
  WorkflowPutInputSchema,
  WorkflowSchema,
} from '../workflow.js';
import { ComposedWorkflowSchema } from '../../cybernetic/stagedChangeSkillCompose.js';
import { skillUsageSummary } from '../../cybernetic/skillDiscovery.js';

const USAGE = {
  whenToUse: ['Fixing a bug in the repository'],
  whenNotToUse: ['Publishing — that is Publish Local Changes'],
  next: [{ skill: 'publish-local-changes', when: 'Once the patch is back' }],
  pitfalls: ['Start it with wait: none'],
};

const workflow = {
  slug: 'commission-change',
  name: 'Commission Change',
  description: 'Make a change',
  usage: USAGE,
  mode: 'process',
  outcomes: [{ id: 'done', name: 'Done', evaluator: { type: 'manual', instruction: 'Done.' } }],
  tasks: [{ taskId: 'commission', name: 'Make the change', type: 'agent', goal: 'Make it' }],
};

describe('skill usage', () => {
  it('defaults every list, so a block may name only what it has', () => {
    expect(SkillUsageSchema.parse({ whenToUse: ['x'] })).toEqual({
      whenToUse: ['x'],
      whenNotToUse: [],
      next: [],
      pitfalls: [],
    });
  });

  it('names exactly one of a skill or an operation as what follows', () => {
    expect(
      SkillUsageNextSchema.safeParse({ skill: 'publish-local-changes', when: 'a' }).success,
    ).toBe(true);
    expect(
      SkillUsageNextSchema.safeParse({ operation: 'agent.schedule.create', when: 'a' }).success,
    ).toBe(true);
    expect(
      SkillUsageNextSchema.safeParse({
        skill: 'a-skill',
        operation: 'agent.schedule.create',
        when: 'a',
      }).success,
    ).toBe(false);
    expect(SkillUsageNextSchema.safeParse({ when: 'a' }).success).toBe(false);
  });

  it('is kept beside the description by every shape a workflow is written in', () => {
    expect(ComposedWorkflowSchema.parse(workflow).usage).toEqual(USAGE);
    expect(WorkflowPutInputSchema.safeParse(workflow).success).toBe(true);
    const stored = WorkflowSchema.shape.usage.parse(USAGE);
    expect(stored).toEqual(USAGE);
  });

  it('is returned by the invocation view', () => {
    const invocation = WorkflowGetOutputSchema.options[1];
    expect(Object.keys(invocation.shape.workflow.shape)).toContain('usage');
  });

  it('summarises for search and pinned summaries without the pitfalls themselves', () => {
    expect(skillUsageSummary(USAGE)).toEqual({
      whenToUse: USAGE.whenToUse,
      whenNotToUse: USAGE.whenNotToUse,
      next: USAGE.next,
      pitfallCount: 1,
    });
    expect(skillUsageSummary({ whenToUse: [], whenNotToUse: [], next: [], pitfalls: [] })).toBe(
      undefined,
    );
  });
});
