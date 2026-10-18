import { describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from './types.js';
const { load, error } = vi.hoisted(() => ({ load: vi.fn(), error: vi.fn() }));
vi.mock('@aflow/database', async (original) => ({
  ...(await original<typeof import('@aflow/database')>()),
  getDatabase: () => ({}),
}));
vi.mock('@aflow/cybernetic-runtime', async (original) => ({
  ...(await original<typeof import('@aflow/cybernetic-runtime')>()),
  loadHelmsmanDiscovery: load,
}));
vi.mock('./helpers.js', () => ({ emitStepError: error }));
const { enforceSkillSelection } = await import('./skillDiscovery.js');
function args(helmsman: boolean, dependency = false): InlineHandlerArgs {
  return {
    context: {
      tenantId: 'tenant',
      spaceId: 'space',
      agentDefinition: { metadata: { system: helmsman, tags: ['helmsman', 'cybernetic'] } },
    },
    ...(dependency ? { workflowExecution: { runId: 'parent' } } : {}),
  } as unknown as InlineHandlerArgs;
}
describe('skill placement enforcement', () => {
  it('refuses a known off slug for Helmsman before starting work', async () => {
    load.mockResolvedValue({ skillPlacements: { 'hidden-skill': 'off' } });
    expect(await enforceSkillSelection(args(true), 'hidden-skill', 0)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.anything(),
      'SKILL_OFF_FOR_HELMSMAN',
      expect.stringContaining('hidden-skill'),
      0,
      'permission',
      false,
    );
  });
  it('keeps direct operator execution and declared dependencies available', async () => {
    load.mockClear();
    expect(await enforceSkillSelection(args(false), 'hidden-skill', 0)).toBe(true);
    expect(await enforceSkillSelection(args(true, true), 'hidden-skill', 0)).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
  it('uses the current setting rather than a session’s stale skill catalog', async () => {
    load
      .mockResolvedValueOnce({ skillPlacements: { 'hidden-skill': 'off' } })
      .mockResolvedValueOnce({ skillPlacements: { 'hidden-skill': 'on_demand' } });
    expect(await enforceSkillSelection(args(true), 'hidden-skill', 0)).toBe(false);
    expect(await enforceSkillSelection(args(true), 'hidden-skill', 0)).toBe(true);
  });
});
