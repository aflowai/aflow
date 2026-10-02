import { describe, expect, it } from 'vitest';
import type { EditionDescriptor } from '@aflow/schemas';
import { resolveListenHost } from './listenHost.js';

const hosted: EditionDescriptor = {
  edition: 'enterprise',
  authProvider: 'auth0',
  tenancy: { mode: 'multi' },
  exposure: { bind: 'any', requireTls: true },
  computeRuntime: 'present',
  codeLane: 'present',
  hostLane: 'absent',
  browserLane: 'absent',
};

const appliance: EditionDescriptor = {
  edition: 'community-local',
  authProvider: 'local-instance',
  tenancy: { mode: 'fixed', tenantId: '00000000-0000-4000-8000-0000000ed1c0' },
  exposure: { bind: 'loopback', requireTls: false },
  computeRuntime: 'absent',
  codeLane: 'absent',
  hostLane: 'absent',
  browserLane: 'absent',
};

describe('resolveListenHost', () => {
  it('keeps the hosted product listening on every interface', () => {
    expect(resolveListenHost(hosted, {})).toBe('0.0.0.0');
    expect(resolveListenHost(hosted, { HOST: '10.0.0.4' })).toBe('10.0.0.4');
  });

  it('binds the appliance to loopback', () => {
    expect(resolveListenHost(appliance, {})).toBe('127.0.0.1');
    expect(resolveListenHost(appliance, { HOST: '   ' })).toBe('127.0.0.1');
  });

  it.each(['127.0.0.1', '::1', 'localhost'])('accepts %s as loopback', (host) => {
    expect(resolveListenHost(appliance, { HOST: host })).toBe(host);
  });

  // Otherwise the descriptor states a containment the socket does not have.
  it.each(['0.0.0.0', '192.168.1.10', '::'])('refuses to publish the appliance on %s', (host) => {
    expect(() => resolveListenHost(appliance, { HOST: host })).toThrow(/beyond loopback/);
  });

  it('publishes the appliance when the operator asked for it', () => {
    const published: EditionDescriptor = {
      ...appliance,
      exposure: { bind: 'any', requireTls: true },
      computeRuntime: 'absent',
      codeLane: 'absent',
      hostLane: 'absent',
      browserLane: 'absent',
    };
    expect(resolveListenHost(published, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('binds every interface inside a container, where loopback would be unreachable', () => {
    const contained = { ...appliance, exposure: { bind: 'container' as const, requireTls: false } };
    expect(resolveListenHost(contained, {})).toBe('0.0.0.0');
  });

  // The published port forwards to the container's address, not its loopback,
  // so this narrowing would have made the process unreachable instead.
  it.each(['127.0.0.1', 'localhost', '::1'])(
    'refuses HOST=%s inside a container, where it reaches nothing',
    (host) => {
      const contained = {
        ...appliance,
        exposure: { bind: 'container' as const, requireTls: false },
      };
      expect(() => resolveListenHost(contained, { HOST: host })).toThrow(/cannot reach/);
    },
  );

  it('still honours a routable HOST inside a container', () => {
    const contained = { ...appliance, exposure: { bind: 'container' as const, requireTls: false } };
    expect(resolveListenHost(contained, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});
