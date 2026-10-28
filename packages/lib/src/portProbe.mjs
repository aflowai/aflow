/**
 * Whether something already listens on a TCP port on this machine, decided by
 * binding it.
 *
 * Plain JavaScript, because the dev runner (`scripts/dev.mjs`) runs it under
 * `node` with no TypeScript loader, and the host executor imports the same
 * file through `@aflow/lib/port-probe`.
 */
import { createServer } from 'node:net';

/**
 * Each address is tried on its own because macOS lets a wildcard bind succeed
 * beside a loopback-only listener and a loopback bind beside a wildcard one.
 * The IPv6 wildcard is bound `ipv6Only`, or it would collide with its IPv4 twin.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function portTaken(port) {
  for (const host of ['0.0.0.0', '::', '127.0.0.1', '::1']) {
    /** @type {boolean} */
    const inUse = await new Promise((resolve) => {
      const probe = createServer();
      probe.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
        resolve(error.code === 'EADDRINUSE');
      });
      probe.listen({ port, host, ipv6Only: host === '::' }, () => {
        probe.close(() => {
          resolve(false);
        });
      });
    });
    if (inUse) return true;
  }
  return false;
}
