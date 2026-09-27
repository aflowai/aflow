/**
 * Shared host-directory root for every sandbox bind-mount.
 *
 * THE INVARIANT (load-bearing for the whole compute substrate): any host
 * directory we bind-mount into a sandbox container (`-v hostDir:/...`) must
 * resolve to the SAME bytes in two filesystem namespaces:
 *   1. the executor process's filesystem — where we write the files, and
 *   2. the Docker daemon's filesystem — which the `-v` source is resolved against.
 *
 * In local dev these are the same machine, so `os.tmpdir()` satisfies the
 * invariant for free. In production the executor runs INSIDE the
 * `phoenix-worker` container and talks to the HOST Docker daemon over the
 * mounted `/var/run/docker.sock`. A path under the worker container's own
 * `/tmp` does not exist on the host, so the daemon silently creates an empty
 * directory and bind-mounts THAT — the sandbox sees an empty `/workspace`
 * (or `/tmp/input`) even though hydrate wrote real files. That is the
 * "hydrated but empty" failure: `workspaceFlush.hydratedPaths` is populated
 * (the manifest is truthful about what the executor wrote to its own FS) while
 * the container sees nothing.
 *
 * The fix: write sandbox scratch under `PHOENIX_SANDBOX_HOST_DIR`, a directory
 * the worker container mounts from the host at the IDENTICAL path
 * (`-v /var/lib/phoenix-sandbox:/var/lib/phoenix-sandbox`). Then the path means
 * the same thing in both namespaces. Defaults to `os.tmpdir()` so local dev and
 * unit tests are unchanged.
 *
 * Scope: bind-mounted dirs (/workspace, /tmp/input, /tmp/output) MUST use this —
 * that is the invariant. The other sandbox scratch dirs (session checkpoint copy,
 * file-inject staging) reach the container via `docker cp`/tar, not a bind-mount,
 * so they do not strictly need it — but they route through here too, on purpose:
 * one mental model ("all sandbox scratch lives under the base dir") means new
 * bind-mount code can't reintroduce the empty-mount bug by copy-pasting a nearby
 * `tmpdir()` call, and it keeps all scratch in one sized/inspectable location for
 * host-disk quota + cleanup. A guard test (sandboxScratchConsolidation.test.ts)
 * fails if any handler constructs scratch via `tmpdir()` instead of this helper.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Env var that overrides the sandbox scratch root (set on the prod worker). */
export const SANDBOX_HOST_DIR_ENV = 'PHOENIX_SANDBOX_HOST_DIR';

/**
 * Root directory for all bind-mounted sandbox scratch dirs (workspace hydrate,
 * input files, output capture). Reads `PHOENIX_SANDBOX_HOST_DIR` at call time
 * (not module load) so tests can set/unset it per case. Falls back to
 * `os.tmpdir()`.
 */
export function sandboxHostBaseDir(): string {
  const override = process.env[SANDBOX_HOST_DIR_ENV]?.trim();
  return override && override.length > 0 ? override : tmpdir();
}

/**
 * Build a unique scratch path under the sandbox base dir. Does NOT create the
 * directory — the caller mkdir's it (some callers also chmod 0o777 for the
 * non-root container user).
 */
export function sandboxScratchDir(name: string): string {
  return join(sandboxHostBaseDir(), name);
}
