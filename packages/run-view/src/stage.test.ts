import { describe, expect, it } from 'vitest';
import { deriveStagedApplet } from './stage.js';
import type { ConversationItem } from './types.js';

function appletItem(itemId: string, instanceId: string, createdAtMs: number): ConversationItem {
  return {
    kind: 'inline_applet',
    itemId,
    anchorStepExecutionId: `step-${itemId}`,
    instanceId,
    createdAtMs,
  };
}

describe('deriveStagedApplet', () => {
  it('the latest applet mount is the stage', () => {
    const staged = deriveStagedApplet([
      appletItem('a', 'game-1', 100),
      appletItem('c', 'game-1', 300),
    ]);
    expect(staged).toEqual({ instanceId: 'game-1', itemId: 'c' });
  });

  it('a newer instance takes the stage from an older one', () => {
    const staged = deriveStagedApplet([
      appletItem('a', 'game-1', 100),
      appletItem('b', 'game-2', 200),
    ]);
    expect(staged?.instanceId).toBe('game-2');
  });

  it('an instance that moved is still one instance, staged where it moved to', () => {
    // The card follows the step that last referenced it, and there is only ever
    // one of it — a session that reads the board every turn stages the board,
    // not a history of boards.
    const staged = deriveStagedApplet([appletItem('c', 'game-1', 300)]);
    expect(staged).toEqual({ instanceId: 'game-1', itemId: 'c' });
  });

  it('no applet mount — no stage, the room renders as before', () => {
    expect(deriveStagedApplet([])).toBeNull();
  });
});
