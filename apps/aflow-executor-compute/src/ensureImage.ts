import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const PULL_TIMEOUT_MS = 180_000;
const INSPECT_TIMEOUT_MS = 5_000;

/**
 * Registry host of a private Google Artifact Registry / GCR image, or null for
 * a Docker Hub image. Docker treats a first path segment without a `.` or `:`
 * as a Hub library namespace, not a hostname, so those are never AR.
 */
export function googleRegistryHost(image: string): string | null {
  const host = image.split('/')[0];
  if (!host || (!host.includes('.') && !host.includes(':'))) return null;
  if (host === 'gcr.io' || host.endsWith('.gcr.io') || host.endsWith('.pkg.dev')) return host;
  return null;
}

/**
 * Whether this is an image the repository builds rather than one a registry
 * serves.
 *
 * `phoenix-` is the existing marker for it: `getImageForRuntime` uses the same
 * prefix to decide what `COMPUTE_IMAGE_PREFIX` redirects to Artifact Registry.
 * Without that prefix the name stays bare, and a bare name is a Docker Hub
 * library reference — so pulling one reports that the repository does not exist
 * or needs a login, which is true of Hub and beside the point here. It was never
 * going to be there.
 */
export function isRepositoryBuiltImage(image: string): boolean {
  return googleRegistryHost(image) === null && image.startsWith('phoenix-');
}

function runDocker(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`docker ${args[0] ?? ''} failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`docker ${args[0] ?? ''} exited ${code ?? 'null'}: ${stderr.trim()}`));
    });
  });
}

async function imageExistsLocally(image: string): Promise<boolean> {
  try {
    await runDocker(['image', 'inspect', image], INSPECT_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

async function fetchMetadataAccessToken(timeoutMs = 3_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { access_token?: unknown };
    return typeof body.access_token === 'string' ? body.access_token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pullWithArtifactRegistryAuth(image: string, registryHost: string): Promise<void> {
  const token = await fetchMetadataAccessToken();
  if (!token) {
    // No metadata identity (e.g. local dev) — attempt an unauthenticated pull
    // and let it throw if the registry rejects it.
    await runDocker(['pull', '-q', image], PULL_TIMEOUT_MS);
    return;
  }
  const configDir = await mkdtemp(join(tmpdir(), 'phoenix-docker-'));
  try {
    const auth = Buffer.from(`oauth2accesstoken:${token}`).toString('base64');
    const config = JSON.stringify({ auths: { [registryHost]: { auth } } });
    await writeFile(join(configDir, 'config.json'), config, 'utf-8');
    await runDocker(['--config', configDir, 'pull', '-q', image], PULL_TIMEOUT_MS);
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ensure a Docker image is present locally, pulling it if missing.
 *
 * The compute executor reaches the host Docker daemon over a mounted socket, so
 * pull credentials come from the docker *client* config, not the daemon. Private
 * Artifact Registry images (the ML runtime) therefore need a token minted at
 * pull time — the boot-time `docker login` token expires after 60 min and is not
 * shared into this container. A missing image throws rather than proceeding to a
 * `docker run` that would die on an absent image, so the step fails clearly and
 * can retry once the image lands.
 */
export async function ensureImageAvailable(image: string): Promise<void> {
  if (await imageExistsLocally(image)) return;

  if (isRepositoryBuiltImage(image)) {
    throw new Error(
      `The ${image} runtime image is not built on this machine. ` +
        'It is built here rather than pulled — `yarn compute:build-ml` builds it ' +
        '(~2.6GB, a few minutes). Set COMPUTE_IMAGE_PREFIX instead to take it from a registry.',
    );
  }

  const registryHost = googleRegistryHost(image);
  if (registryHost) {
    await pullWithArtifactRegistryAuth(image, registryHost);
  } else {
    await runDocker(['pull', '-q', image], PULL_TIMEOUT_MS);
  }
}
