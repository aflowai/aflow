/**
 * Where the executor and every command line find the host directory: one
 * resolver, so the precedence is tested once, here.
 */
import { describe, expect, it } from 'vitest';

import { resolveHostDir, resolveHostPolicyPath } from '../hostDir.js';

const HOME = '/Users/op';

describe('the host directory', () => {
  it('is the policy path the override names, and its directory', () => {
    const env = {
      PHOENIX_HOST_POLICY_PATH: '/srv/aflow/policy.json',
      PHOENIX_HOST_DIR: '/elsewhere',
    };
    expect(resolveHostPolicyPath(env, HOME)).toBe('/srv/aflow/policy.json');
    expect(resolveHostDir(env, HOME)).toBe('/srv/aflow');
  });

  it('is PHOENIX_HOST_DIR when no policy path is named', () => {
    const env = { PHOENIX_HOST_DIR: ' /srv/host ' };
    expect(resolveHostPolicyPath(env, HOME)).toBe('/srv/host/host-policy.json');
    expect(resolveHostDir(env, HOME)).toBe('/srv/host');
  });

  it('treats an empty setting as unset, falling back to ~/.aflow', () => {
    const env = { PHOENIX_HOST_POLICY_PATH: '  ', PHOENIX_HOST_DIR: '' };
    expect(resolveHostPolicyPath(env, HOME)).toBe('/Users/op/.aflow/host-policy.json');
    expect(resolveHostDir(env, HOME)).toBe('/Users/op/.aflow');
    expect(resolveHostDir({}, HOME)).toBe('/Users/op/.aflow');
  });
});
