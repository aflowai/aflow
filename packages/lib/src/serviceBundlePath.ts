/**
 * Which compiled entry a launcher service runs.
 *
 * One rule rather than a table of ten identical paths: every service is one
 * workspace's `dist/index.js`, and a table can name a workspace the
 * distribution does not ship.
 *
 * The server is the exception. Its composition roots are separate workspaces,
 * and the artifact decides which — it serves the widest root it contains rather
 * than the one a deployment remembered to name, because a deploy path that
 * forgot would serve a quietly smaller product with nothing failing. Preferring the wider root cannot
 * widen what a local process serves: the resolved edition filters the
 * composition, so a hosted artifact run as `community-local` serves the core
 * tier alone.
 */

export interface ServerRootLookup {
  /** Overrides the choice entirely — a distribution whose root is elsewhere. */
  override?: string | undefined;
  /** Whether a path exists in the artifact. */
  exists: (path: string) => boolean;
}

export const CORE_SERVER_ROOT = 'apps/server/dist/index.js';
export const HOSTED_SERVER_ROOT = 'apps/server-hosted/dist/index.js';

export function serverBundlePath({ override, exists }: ServerRootLookup): string {
  if (override !== undefined && override !== '') return override;
  return exists(HOSTED_SERVER_ROOT) ? HOSTED_SERVER_ROOT : CORE_SERVER_ROOT;
}

export function serviceBundlePath(service: string, server: ServerRootLookup): string {
  if (service === 'server') return serverBundlePath(server);
  const workspace = service === 'orchestrator' ? 'aflow-orchestrator' : `aflow-${service}`;
  return `apps/${workspace}/dist/index.js`;
}
