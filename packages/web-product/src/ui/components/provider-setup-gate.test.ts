/**
 * What the shell does with a workspace that exists but cannot answer.
 *
 * The appliance bootstraps a workspace, so the wizard that names one never
 * opens — and the model and credential steps that make it answer were only
 * reachable through that wizard. The operator met a chat that could not reply,
 * which the first-run design rules out as a completion state.
 *
 * The window this pins is the cold load. Readiness and the workspace arrive
 * from separate requests, and treating either unanswered as "not ready" puts a
 * setup screen in front of a workspace that turns out to be fine.
 */
import { describe, it, expect } from 'vitest';
import { resolveProviderSetupResume } from './space-gate';
import type { SpaceLlmReadiness } from '../hooks/useSpaceLlmReadiness.js';
import type { SpaceDetail } from '../hooks/use-space-detail.js';

const SPACE_ID = '6ea90857-1b35-4810-9700-9e6125a1f4ac';

/**
 * Shaped as `GET /spaces/:id` actually answers: `id`, and no `spaceId`. The
 * field the type once required is the one the endpoint never sends.
 */
const SPACE: SpaceDetail = {
  id: SPACE_ID,
  name: 'General',
  slug: 'general',
  description: null,
  defaultAgentId: null,
  directives: { version: 1, responsibility: 'Bootstrapped workspace.', learningPolicy: {} },
};

const UNREADY: SpaceLlmReadiness = {
  ready: false,
  roles: {},
  clerk: {
    mode: 'auto',
    model: null,
    modelId: null,
    providerId: null,
    credentialResolved: false,
    unavailableReason: null,
  },
  missingProviders: [{ providerId: 'fireworks', roles: ['default'] }],
  erroredProviders: [],
  unknownModelRoles: [],
  unverifiedProviders: [],
  hasConfiguredProvider: false,
};

const READY: SpaceLlmReadiness = {
  ready: true,
  roles: {},
  clerk: {
    mode: 'auto',
    model: null,
    modelId: null,
    providerId: null,
    credentialResolved: false,
    unavailableReason: null,
  },
  missingProviders: [],
  erroredProviders: [],
  unknownModelRoles: [],
  unverifiedProviders: [],
  hasConfiguredProvider: false,
};

/** A key is stored and resolves, but nothing has ever tried it. */
const READY_BUT_UNVERIFIED: SpaceLlmReadiness = {
  ...READY,
  unknownModelRoles: [],
  unverifiedProviders: [{ providerId: 'fireworks', roles: ['default'] }],
};

const base = {
  editionId: 'community-local' as const,
  spaceId: SPACE_ID,
  readiness: UNREADY,
  space: SPACE,
  deferred: false,
};

describe('a local workspace that cannot run', () => {
  it('resumes setup on it rather than opening a chat that cannot reply', () => {
    expect(resolveProviderSetupResume(base)).toEqual({
      id: SPACE_ID,
      name: 'General',
      slug: 'general',
      directives: SPACE.directives,
    });
  });

  /**
   * The id comes from context, never from the detail payload. `GET /spaces/:id`
   * answers with `id` and no `spaceId`, so a resume target reading the latter
   * carried `undefined` into the model step's PATCH and the route rejected it
   * as an invalid uuid — after the operator had already chosen a model.
   */
  it('takes the id from context, so a payload without one still resumes', () => {
    const { id: _omitted, ...withoutId } = SPACE;
    const resumed = resolveProviderSetupResume({
      ...base,
      space: withoutId as SpaceDetail,
    });
    expect(resumed?.id).toBe(SPACE_ID);
  });

  it('withholds the gate when there is no active space to resume on', () => {
    expect(resolveProviderSetupResume({ ...base, spaceId: null })).toBeNull();
  });

  /**
   * The model step writes the directives object back whole. A resumed flow
   * carrying a stub would replace what bootstrap and the operator put there,
   * so the workspace's own directives travel with it.
   */
  it('carries the workspace directives, not a stub', () => {
    const resumed = resolveProviderSetupResume(base);
    expect(resumed?.directives).toBe(SPACE.directives);
  });
});

describe('while the answers are still arriving', () => {
  it('withholds the gate until readiness is known', () => {
    expect(resolveProviderSetupResume({ ...base, readiness: null })).toBeNull();
  });

  it('withholds the gate until the workspace is known', () => {
    expect(resolveProviderSetupResume({ ...base, space: null })).toBeNull();
  });

  it('withholds the gate until the edition is known', () => {
    expect(resolveProviderSetupResume({ ...base, editionId: null })).toBeNull();
  });
});

describe('everywhere else', () => {
  it('leaves a ready workspace alone', () => {
    expect(resolveProviderSetupResume({ ...base, readiness: READY })).toBeNull();
  });

  /**
   * `ready` is true from the moment a credential row exists — the row is stored
   * active before anything tries the key in it. The flow tells an operator
   * whose check failed that they can fix it later, and this is what makes a
   * later exist.
   */
  it('reopens on a key nothing has tried, which reports ready', () => {
    expect(resolveProviderSetupResume({ ...base, readiness: READY_BUT_UNVERIFIED })).not.toBeNull();
  });

  it('still respects a deferral on an unverified key', () => {
    expect(
      resolveProviderSetupResume({ ...base, readiness: READY_BUT_UNVERIFIED, deferred: true }),
    ).toBeNull();
  });

  /**
   * The hosted product admits people into workspaces somebody else configured,
   * where the reader of an unready space is often not the person holding its
   * credentials. Stopping them would block work they can do to demand
   * something they cannot.
   */
  it('leaves the hosted edition alone', () => {
    expect(resolveProviderSetupResume({ ...base, editionId: 'enterprise' })).toBeNull();
  });

  it('does not reopen on an operator who chose to carry on', () => {
    expect(resolveProviderSetupResume({ ...base, deferred: true })).toBeNull();
  });
});

/**
 * The loop this replaces: choosing a model whose provider has no key made the
 * workspace unready, the gate replaced every page with the wizard, and the
 * wizard's own reload recomputed the same condition — so it could not be left.
 */
describe('a workspace that is past first run', () => {
  const configured = (over: Partial<SpaceLlmReadiness>): SpaceLlmReadiness => ({
    ...UNREADY,
    hasConfiguredProvider: true,
    ...over,
  });

  it('does not open the wizard when a newly chosen model has no key', () => {
    expect(
      resolveProviderSetupResume({
        ...base,
        readiness: configured({ missingProviders: [{ providerId: 'xai', roles: ['default'] }] }),
      }),
    ).toBeNull();
  });

  it('does not open the wizard when a key stops working', () => {
    expect(
      resolveProviderSetupResume({
        ...base,
        readiness: configured({
          erroredProviders: [{ providerId: 'openai', roles: ['default'], lastErrorCode: '401' }],
        }),
      }),
    ).toBeNull();
  });

  it('does not open the wizard for a model the catalog dropped', () => {
    expect(
      resolveProviderSetupResume({
        ...base,
        readiness: configured({ unknownModelRoles: [{ role: 'default', model: 'retired-1' }] }),
      }),
    ).toBeNull();
  });

  it('still opens it on a genuinely unconfigured instance', () => {
    expect(
      resolveProviderSetupResume({
        ...base,
        readiness: { ...UNREADY, hasConfiguredProvider: false },
      }),
    ).not.toBeNull();
  });
});
