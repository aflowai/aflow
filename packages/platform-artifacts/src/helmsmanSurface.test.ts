import { describe, expect, it } from 'vitest';
import type { ComposedLanes } from '@aflow/schemas';
import { isOperationComposed } from '@aflow/schemas';
import { composeHelmsmanSurface } from './helmsmanSurface.js';
import { CYBERNETIC_AGENTS, HELMSMAN_DISCOVERY_PRESET } from './cyberneticAgents.js';

function registryDefaults(): {
  coreOperations: readonly string[];
  promotableOperations: readonly string[];
} {
  const helmsman = CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman');
  const step = (helmsman!.steps as Array<Record<string, unknown>>).find(
    (s) => s['stepId'] === 'agent',
  );
  const config = step!['config'] as Record<string, unknown>;
  const catalog = config['catalog'] as Record<string, unknown>;
  const discovery = catalog['discovery'] as Record<string, unknown>;
  return {
    coreOperations: catalog['coreOperations'] as string[],
    promotableOperations: discovery['allowedOperationIds'] as string[],
  };
}

const HOSTED: ComposedLanes = {
  edition: 'enterprise',
  codeLane: 'present',
  hostLane: 'absent',
  browserLane: 'absent',
};
const APPLIANCE: ComposedLanes = {
  edition: 'community-local',
  codeLane: 'absent',
  hostLane: 'present',
  browserLane: 'present',
};

describe('composeHelmsmanSurface', () => {
  it('returns the registry default unchanged for a hosted edition composing every lane', () => {
    const authored = registryDefaults();
    const composed = composeHelmsmanSurface(authored, {
      ...HOSTED,
      hostLane: 'present',
      browserLane: 'present',
    });

    expect(composed.coreOperations).toEqual([...authored.coreOperations]);
    expect(composed.promotableOperations).toEqual([...HELMSMAN_DISCOVERY_PRESET]);
  });

  it('drops only the machine operations from the hosted ceiling while no machine is paired', () => {
    const authored = registryDefaults();
    const composed = composeHelmsmanSurface(authored, HOSTED);

    expect(composed.coreOperations).toEqual([...authored.coreOperations]);
    expect(composed.promotableOperations).toEqual(
      authored.promotableOperations.filter((op) => !op.startsWith('host.')),
    );
    expect(authored.promotableOperations.some((op) => op.startsWith('host.'))).toBe(true);
  });

  it('names nothing in either tier that the edition does not compose', () => {
    const authored = registryDefaults();
    for (const lanes of [HOSTED, APPLIANCE, { ...APPLIANCE, hostLane: 'absent' as const }]) {
      const composed = composeHelmsmanSurface(authored, lanes);
      for (const op of [...composed.coreOperations, ...composed.promotableOperations]) {
        expect(isOperationComposed(op, lanes)).toBe(true);
      }
    }
    expect(authored.promotableOperations.some((op) => op.startsWith('code.'))).toBe(true);
  });

  it('pins the machine reads and the harness on the local edition', () => {
    const authored = registryDefaults();
    const composed = composeHelmsmanSurface(authored, APPLIANCE);

    const added = composed.coreOperations.filter((op) => !authored.coreOperations.includes(op));
    const removed = authored.coreOperations.filter((op) => !composed.coreOperations.includes(op));

    expect(added).toEqual(['host.harness.run', 'host.file.list', 'host.file.get']);
    expect(removed).toEqual([
      'workflow.campaign.list',
      'workflow.campaign.get',
      'ui.surface.visualize',
    ]);
    expect(composed.coreOperations.length).toBe(authored.coreOperations.length);
  });

  it('keeps the machine writes and shell promotable on the local edition', () => {
    const authored = registryDefaults();
    const composed = composeHelmsmanSurface(authored, APPLIANCE);

    for (const op of [
      'host.file.put',
      'host.file.patch',
      'host.process.exec',
      'host.process.input',
      'host.process.inspect',
      'host.process.stop',
    ]) {
      expect(composed.promotableOperations).toContain(op);
    }

    const removed = authored.promotableOperations.filter(
      (op) => !composed.promotableOperations.includes(op),
    );
    const added = composed.promotableOperations.filter(
      (op) => !authored.promotableOperations.includes(op),
    );

    const uncomposed = authored.promotableOperations.filter((op) => op.startsWith('code.'));
    expect(uncomposed.length).toBeGreaterThan(0);
    expect(removed.sort()).toEqual(
      [...uncomposed, 'host.harness.run', 'host.file.list', 'host.file.get'].sort(),
    );
    expect(added).toEqual([
      'workflow.campaign.list',
      'workflow.campaign.get',
      'ui.surface.visualize',
    ]);
  });

  it('keeps the local edition hosted-shaped while no machine is paired', () => {
    const authored = registryDefaults();
    const lanes = { ...APPLIANCE, hostLane: 'absent' as const };
    const composed = composeHelmsmanSurface(authored, lanes);

    expect(composed.coreOperations).toEqual([...authored.coreOperations]);
    expect(composed.promotableOperations).toEqual(
      authored.promotableOperations.filter((op) => isOperationComposed(op, lanes)),
    );
  });

  it('adds nothing twice when applied to an already composed surface', () => {
    const authored = registryDefaults();
    const once = composeHelmsmanSurface(authored, APPLIANCE);
    const twice = composeHelmsmanSurface(
      { coreOperations: once.coreOperations, promotableOperations: once.promotableOperations },
      APPLIANCE,
    );

    expect(twice).toEqual(once);
  });
});

describe('Helmsman does not hold workflow.manage.put', () => {
  it('is absent from the promotable set — skills reach the playbook through compose-skill', () => {
    expect(HELMSMAN_DISCOVERY_PRESET).not.toContain('workflow.manage.put');
  });
});
