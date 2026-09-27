/**
 * The interface the API listens on, decided by the edition rather than by
 * whichever `HOST` happens to be in the environment.
 *
 * The local edition's instance secret is long-lived and its only holder is a
 * BFF beside it, so whatever stands in front of the listener is what keeps
 * that secret off the network the appliance sits on. A descriptor that
 * resolved `bind: 'loopback'` while the process listened on every interface
 * would state a containment it does not have.
 *
 * `container` is the case where binding loopback would be wrong rather than
 * safe: the boundary is the network namespace and how the port was published,
 * and a process bound to loopback inside a container is unreachable from the
 * loopback port its own operator published.
 */
import type { EditionDescriptor } from '@aflow/schemas';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function resolveListenHost(
  edition: EditionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env['HOST']?.trim();
  const explicit = configured === undefined || configured === '' ? undefined : configured;

  if (edition.exposure.bind === 'loopback') {
    if (explicit !== undefined && !LOOPBACK_HOSTS.has(explicit)) {
      throw new Error(
        `Refusing to start: HOST=${explicit} publishes this process beyond loopback, ` +
          'which the resolved edition does not allow. Set PHOENIX_BIND=any with ' +
          'PHOENIX_REQUIRE_TLS=true to publish it deliberately.',
      );
    }
    return explicit ?? '127.0.0.1';
  }

  // A container's boundary is its namespace and how the port was published, so
  // binding loopback in here reaches nothing: the published port forwards to
  // the container's address, not to its loopback. An operator who set this
  // meant to narrow the exposure and would instead have made the process
  // unreachable, with a healthy-looking container to show for it.
  if (
    edition.exposure.bind === 'container' &&
    explicit !== undefined &&
    LOOPBACK_HOSTS.has(explicit)
  ) {
    throw new Error(
      `Refusing to start: HOST=${explicit} binds only loopback inside this container, ` +
        'which the published port cannot reach. Leave HOST unset — the namespace and the ' +
        'loopback-published port are what contain this process — or run it outside a ' +
        'container with PHOENIX_BIND=loopback.',
    );
  }

  return explicit ?? '0.0.0.0';
}
