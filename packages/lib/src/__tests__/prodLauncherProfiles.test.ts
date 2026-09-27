/**
 * Contract: every executor app on disk is reachable from a production profile.
 *
 * The orchestrator refuses to enqueue a step whose type has no live executor
 * heartbeat, so an executor missing from `scripts/prod-launcher.mjs` fails
 * only in production, at the first step of that type — dev is immune because
 * `yarn dev:all` starts executors from its own list. Exceptions are explicit:
 * the mock executor is dev-only, and two executors deliberately run in their
 * own profiles on dedicated instances.
 *
 * This contract proves an executor has a HOME profile, not that anything
 * launches it — a dedicated profile whose host is stopped fails the same way
 * a missing entry does, and only the deploy path can tell them apart. See
 * `DEDICATED_PROFILE_EXECUTORS`.
 *
 * An executor that ships outside the image has no home here to prove. It is
 * installed and launched on the operator's own machine, so the launcher never
 * sees it and a profile would describe nothing. Its manifest says so with
 * `phoenix.shipsInImage: false`, the same declaration the Dockerfile contract
 * reads, rather than a second list that could disagree with the first.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');

const DEV_ONLY_EXECUTORS = ['aflow-executor-mock'];

/** Installed on the operator's machine, so the appliance launcher never runs it. */
function shipsInImage(app: string): boolean {
  const raw: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, 'apps', app, 'package.json'), 'utf8'),
  );
  const phoenix =
    typeof raw === 'object' && raw !== null
      ? (raw as { phoenix?: { shipsInImage?: unknown } }).phoenix
      : undefined;
  return phoenix?.shipsInImage !== false;
}
/**
 * Executors whose home is a named profile other than `worker`.
 *
 * `executor-code` stays out of `worker` because the coding lane is the one
 * surface that by design holds credentials, has network egress, and runs a
 * prompt-injectable agent over a real repository. Its containment is a property
 * of the HOST it runs on — an internal lane network with no route out, an
 * egress proxy on the gateway, a metadata block, and its own least-privilege
 * service account — none of which the hot-path worker has or should acquire.
 * Adding it to a shared profile would place that surface on a host built for
 * something else. Local dev is unaffected: `scripts/dev.mjs` starts the
 * executor from its own list.
 *
 * `executor-compute` stays out for the opposite reason: it needs the host
 * Docker daemon to spawn sandboxes, and a process that can reach that socket
 * can ask for a privileged container bind-mounting `/`. That is host root
 * whichever user holds it, so the socket cannot be made safe on the host it
 * sits on — only moved to one where its reach is worth less. On `worker` it
 * sat beside the orchestrator and every model, mail and credential-wrapping
 * secret; `compute-worker` carries a database URL and a Redis password.
 *
 * The two are separate profiles rather than one "dedicated executors" host:
 * the sandbox runs `--network none` and the lane needs egress, so sharing a
 * machine would put an egress-capable container on the host whose isolation
 * story is that nothing egresses.
 */
const DEDICATED_PROFILE_EXECUTORS: Record<string, string> = {
  'aflow-executor-code': 'code-worker',
  'aflow-executor-compute': 'compute-worker',
};

function executorAppDirs(): string[] {
  const base = join(REPO_ROOT, 'apps');
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('aflow-executor-'))
    .filter((e) => shipsInImage(e.name))
    .map((e) => e.name)
    .filter((name) => existsSync(join(base, name, 'package.json')))
    .sort();
}

function extractProfile(launcher: string, profile: string): string {
  const match = new RegExp(`'?${profile}'?:\\s*\\[([^\\]]*)\\]`).exec(launcher);
  if (!match?.[1]) throw new Error(`prod-launcher.mjs: profile "${profile}" not found`);
  return match[1];
}

describe('prod launcher profiles', () => {
  const launcher = readFileSync(join(REPO_ROOT, 'scripts/prod-launcher.mjs'), 'utf-8');

  it('every executor app has a service entry', () => {
    // Matched on the service name, because the launcher derives each bundle
    // path from it rather than listing ten copies of the same path shape. A
    // workspace with no entry is one no profile can name.
    const missing = executorAppDirs()
      .filter((dir) => !DEV_ONLY_EXECUTORS.includes(dir))
      .filter((dir) => !new RegExp(`'${dir.replace('aflow-', '')}':`).test(launcher));
    expect(missing).toEqual([]);
  });

  it('every executor app runs in the worker profile or a named dedicated profile', () => {
    const workerProfile = extractProfile(launcher, 'worker');
    const missing = executorAppDirs()
      .filter((dir) => !DEV_ONLY_EXECUTORS.includes(dir))
      .filter((dir) => {
        const service = dir.replace('aflow-', '');
        const dedicated = DEDICATED_PROFILE_EXECUTORS[dir];
        const home = dedicated ? extractProfile(launcher, dedicated) : workerProfile;
        return !home.includes(`'${service}'`);
      });
    expect(missing).toEqual([]);
  });
});
