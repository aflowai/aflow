import { describe, expect, it } from 'vitest';
import {
  isOperationComposed,
  isStepTypeComposed,
  uncomposedOperationReason,
  type ComposedLanes,
} from './composedOperations.js';

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

describe('isOperationComposed', () => {
  it('hides the coding lane where the edition composes none', () => {
    expect(isOperationComposed('code.agent.run', APPLIANCE)).toBe(false);
    expect(isOperationComposed('code.repo.describe', APPLIANCE)).toBe(false);
    expect(isOperationComposed('code.agent.run', HOSTED)).toBe(true);
  });

  it('hides the host lane where no machine can pair', () => {
    expect(isOperationComposed('host.harness.run', HOSTED)).toBe(false);
    expect(isOperationComposed('host.file.get', HOSTED)).toBe(false);
    expect(isOperationComposed('host.harness.run', APPLIANCE)).toBe(true);
  });

  it('leaves every other lane alone in both editions', () => {
    for (const opId of [
      'memory.store.get',
      'workflow.run.start',
      'compute.sandbox.exec',
      'ui.artifact.render',
    ]) {
      expect(isOperationComposed(opId, HOSTED)).toBe(true);
      expect(isOperationComposed(opId, APPLIANCE)).toBe(true);
    }
  });

  it('composes the browser lane exactly where browserLane is present', () => {
    expect(isStepTypeComposed('browser', APPLIANCE)).toBe(true);
    expect(isStepTypeComposed('browser', HOSTED)).toBe(false);
    expect(isStepTypeComposed('browser', { ...APPLIANCE, browserLane: 'absent' })).toBe(false);
    expect(isOperationComposed('browser.page.open', APPLIANCE)).toBe(true);
    expect(isOperationComposed('browser.page.open', HOSTED)).toBe(false);
  });

  it('answers on the step type, so a bare step type answers the same way', () => {
    expect(isStepTypeComposed('code', APPLIANCE)).toBe(false);
    expect(isStepTypeComposed('host', HOSTED)).toBe(false);
    expect(isStepTypeComposed('memory', HOSTED)).toBe(true);
  });
});

describe('uncomposedOperationReason', () => {
  it('says nothing about an operation the deployment composes', () => {
    expect(uncomposedOperationReason('memory.store.get', APPLIANCE)).toBeNull();
  });

  it('names the operation and the edition that cannot serve it', () => {
    const reason = uncomposedOperationReason('code.agent.run', APPLIANCE);
    expect(reason).toContain('code.agent.run');
    expect(reason).toContain('community-local');
  });

  it('says a browser lives on a paired machine', () => {
    expect(uncomposedOperationReason('browser.page.open', HOSTED)).toBe(
      'lane_not_composed: "browser.page.open" needs the browser lane, a browser on a paired ' +
        'machine, which the enterprise edition running here does not compose. No promotion or ' +
        'call can reach it.',
    );
  });
});
