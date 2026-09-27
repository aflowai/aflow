import { describe, it, expect } from 'vitest';
import { iconOpIdForTask, resolveActionIcon, resolveTaskIcon } from './op-labels';

describe('iconOpIdForTask', () => {
  it('uses the dispatch op id for agent + operation tasks', () => {
    expect(iconOpIdForTask({ taskType: 'agent', operationId: 'ai.agent.turn' })).toBe(
      'ai.agent.turn',
    );
    expect(iconOpIdForTask({ taskType: 'operation', operationId: 'workflow.learn' })).toBe(
      'workflow.learn',
    );
  });

  it('synthesizes the user-interaction op id for human tasks (no operationId)', () => {
    expect(iconOpIdForTask({ taskType: 'human', humanIntent: 'approve' })).toBe(
      'user.interaction.approve',
    );
    expect(iconOpIdForTask({ taskType: 'human', humanIntent: 'collect' })).toBe(
      'user.interaction.ask',
    );
    // Intent unspecified defaults to the input (ask) icon.
    expect(iconOpIdForTask({ taskType: 'human' })).toBe('user.interaction.ask');
  });

  it('returns undefined when nothing identifies the task (pre-taskType rows)', () => {
    expect(iconOpIdForTask({})).toBeUndefined();
  });
});

describe('resolveTaskIcon', () => {
  it('distinguishes the three dispatch families', () => {
    // Agent task → robot (the single agent mark, used wherever an agent is
    // referenced; the dispatch op is `ai.agent.turn`).
    expect(resolveTaskIcon({ taskType: 'agent', operationId: 'ai.agent.turn' })).toBe('robot');
    // Human approve → user (the family icon; outcome is read from the decision
    // pill + status, so a tick would be redundant). Regression guard: it must
    // not fall back to the generic cube the way a no-operationId row used to.
    expect(resolveTaskIcon({ taskType: 'human', humanIntent: 'approve' })).toBe('user');
    // Human collect → chat-dots (an input request, no decision pill).
    expect(resolveTaskIcon({ taskType: 'human', humanIntent: 'collect' })).toBe('chat-dots');
  });

  it('gives operation tasks an op-specific icon, not a cube', () => {
    // Exact override wins.
    expect(resolveTaskIcon({ taskType: 'operation', operationId: 'workflow.learn' })).toBe('book');
    // Falls back to the step-type tier for other workflow.* ops (regression:
    // `workflow` had no fallback, so every workflow op rendered as a cube).
    expect(resolveTaskIcon({ taskType: 'operation', operationId: 'workflow.run.start' })).toBe(
      'git-branch',
    );
    expect(resolveTaskIcon({ taskType: 'operation', operationId: 'memory.store.put' })).toBe(
      'database',
    );
  });

  it('falls through to cube only when the task is truly unidentified', () => {
    expect(resolveTaskIcon({})).toBe('cube');
  });
});

describe('resolveActionIcon layering (exact > step-type > cube)', () => {
  it('prefers an exact op id over the step-type fallback', () => {
    expect(resolveActionIcon('workflow.learn', undefined)).toBe('book');
    expect(resolveActionIcon('workflow.anything.else', undefined)).toBe('git-branch');
  });

  it('covers the catalog step types that previously fell to cube', () => {
    expect(resolveActionIcon('eval.run.judge', undefined)).toBe('scales');
    expect(resolveActionIcon('skill.compose.create', undefined)).toBe('skill');
    expect(resolveActionIcon('mcp.tool.call', undefined)).toBe('plugs-connected');
    // Coding lane (Plan 219) — code.agent.run runs a Claude Code session, so it
    // carries the Claude brand mark; other code.* ops keep the `code` glyph.
    expect(resolveActionIcon('code.agent.run', undefined)).toBe('claude');
    expect(resolveActionIcon('code.repo.push', undefined)).toBe('code');
  });
});
