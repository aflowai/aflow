/**
 * Contract: the appliance stack keeps the browser-facing processes off the
 * datastore network, and keeps each instance secret out of the process that
 * has no use for it.
 *
 * Network split — Redis in this stack authenticates nobody and Postgres holds
 * the fixed credentials written into the compose file, so reachability is the
 * whole of their protection. A service that declares no network joins the
 * default one with everything else, which would let a compromised web or MCP
 * process open a socket straight to either and bypass the API's authorization
 * entirely. Every service is therefore classified here, so adding one forces
 * the choice rather than inheriting the flat network.
 *
 * Secret split — every service runs as the same user, so ownership separates
 * none of them and a mounted file can be reopened at any point after start.
 * What a service mounts is therefore the whole of what it can read, and the
 * values are cut into one volume per audience so that the file holding both
 * secrets reaches only the two services that use both.
 *
 * The environment is the second way in, and it is closed separately: `env_file`
 * entries arrive as exported variables, and sourcing a file that does not
 * mention one leaves that export standing. Not exporting a value is
 * consequently not the same as withholding it, and the unset is what actually
 * withholds it.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.local.yml'), 'utf8');
/** Read as text rather than imported: `apps/server` is not a dependency here. */
const INSTANCE_CONFIG_SOURCE = readFileSync(
  join(REPO_ROOT, 'packages/server-runtime/src/bootstrap/instanceConfig.ts'),
  'utf8',
);

/** Networks each service must be attached to, after the anchor is merged. */
const EXPECTED_NETWORKS: Record<string, readonly string[]> = {
  // Writes the instance's secrets and the Redis ACL, then exits. It reaches no
  // datastore and no service, so it is on no network at all.
  'instance-init': [],
  postgres: ['backend'],
  redis: ['backend'],
  migrate: ['backend'],
  bootstrap: ['backend'],
  api: ['backend', 'frontend'],
  worker: ['backend'],
  // Datastores and the job stream, and nothing browser-facing. It holds the
  // Docker socket, so what it can reach matters more here than anywhere.
  compute: ['backend'],
  web: ['frontend'],
  mcp: ['frontend'],
};

interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** Named volumes carrying any of the instance's own values. */
const CONFIG_VOLUMES = [
  'instance_config',
  'worker_config',
  'web_config',
  'redis_acl',
  'host_config',
  'compute_config',
];

/**
 * Which of those each service mounts, after the anchor is merged. A service
 * absent from a list here cannot read the values in it at all — which is the
 * only separation available when every process runs as the same user.
 */
const EXPECTED_CONFIG_MOUNTS: Record<string, readonly Mount[]> = {
  'instance-init': [
    { source: 'instance_config', target: '/var/lib/aflow/instance', readOnly: false },
    { source: 'redis_acl', target: '/var/lib/aflow/redis', readOnly: false },
    { source: 'worker_config', target: '/var/lib/aflow/worker', readOnly: false },
    { source: 'web_config', target: '/var/lib/aflow/web', readOnly: false },
    { source: 'host_config', target: '/var/lib/aflow/host', readOnly: false },
    { source: 'compute_config', target: '/var/lib/aflow/compute', readOnly: false },
  ],
  postgres: [],
  redis: [{ source: 'redis_acl', target: '/etc/aflow', readOnly: true }],
  // Read-only, and for one value: it relabels entity-event streams, so it needs
  // the Redis credential. It writes no config of its own — that is instance-init
  // and bootstrap.
  migrate: [{ source: 'instance_config', target: '/var/lib/aflow/instance', readOnly: true }],
  bootstrap: [
    { source: 'instance_config', target: '/var/lib/aflow/instance', readOnly: false },
    { source: 'worker_config', target: '/var/lib/aflow/worker', readOnly: false },
    { source: 'web_config', target: '/var/lib/aflow/web', readOnly: false },
  ],
  api: [{ source: 'instance_config', target: '/var/lib/aflow/instance', readOnly: true }],
  worker: [{ source: 'worker_config', target: '/var/lib/aflow/worker', readOnly: true }],
  // None: it runs code in a sandbox and needs no credential to do it. The
  // service holding the host Docker socket is the last one that should also
  // hold the key unwrapping every stored credential.
  // Its Redis credential, read-only, and nothing else — the sandbox host holds
  // no model key, no mail credential and no wrapping key by decision.
  compute: [{ source: 'compute_config', target: '/var/lib/aflow/compute', readOnly: true }],
  web: [{ source: 'web_config', target: '/var/lib/aflow/web', readOnly: true }],
  mcp: [],
};

/** Bootstrap is told where to write each cut; the reader mounts that same path. */
const AUDIENCE_DIRECTORY_VARS: Record<string, string> = {
  worker: 'PHOENIX_WORKER_CONFIG_DIR',
  web: 'PHOENIX_WEB_CONFIG_DIR',
};

function section(name: string): string {
  const start = COMPOSE.indexOf(`\n${name}:\n`);
  if (start === -1) throw new Error(`docker-compose.local.yml: no top-level \`${name}\` key`);
  const body = COMPOSE.slice(start + name.length + 2);
  const end = /\n[a-z]/.exec(body);
  return end === null ? body : body.slice(0, end.index);
}

/** The `x-runtime` anchor — everything above `services:`. */
const ANCHOR = COMPOSE.slice(0, COMPOSE.indexOf('\nservices:\n'));

function serviceBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  for (const line of section('services').split('\n')) {
    const header = /^ {2}([a-z][a-z0-9_-]*):$/.exec(line);
    if (header?.[1] !== undefined) {
      if (current !== null) blocks.set(current, lines.join('\n'));
      current = header[1];
      lines = [];
      continue;
    }
    lines.push(line);
  }
  if (current !== null) blocks.set(current, lines.join('\n'));
  return blocks;
}

/** Flow-style only, which is how every attachment in this file is written. */
function declaredNetworks(block: string): readonly string[] | null {
  const match = /^\s*networks: \[([^\]]*)\]\s*$/m.exec(block);
  if (match?.[1] === undefined) return null;
  return match[1].split(',').map((entry) => entry.trim());
}

function effectiveNetworks(block: string): readonly string[] {
  const own = declaredNetworks(block);
  if (own !== null) return own;
  if (!block.includes('<<: *runtime')) return [];
  return declaredNetworks(ANCHOR) ?? [];
}

/** Block-style list under a `volumes:` key, which is how this file writes them. */
function declaredVolumes(block: string): readonly string[] | null {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^\s*volumes:\s*$/.test(line));
  if (start === -1) return null;

  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const entry = /^\s*- (.+?)\s*$/.exec(line)?.[1];
    if (entry === undefined) break;
    entries.push(entry);
  }
  return entries;
}

function parseMount(entry: string): Mount {
  const [source, target, mode] = entry.split(':');
  if (source === undefined || target === undefined) {
    throw new Error(`docker-compose.local.yml: unreadable volume entry \`${entry}\``);
  }
  return { source, target, readOnly: mode === 'ro' };
}

/**
 * A service declaring its own `volumes:` replaces the anchor's list outright —
 * a merge key overrides rather than appends — so the effective mounts are one
 * or the other, never both.
 */
function effectiveMounts(block: string): readonly Mount[] {
  const own = declaredVolumes(block);
  const entries = own ?? (block.includes('<<: *runtime') ? (declaredVolumes(ANCHOR) ?? []) : []);
  return entries.map(parseMount);
}

function configMounts(service: string): readonly Mount[] {
  const block = SERVICES.get(service);
  if (block === undefined) throw new Error(`no \`${service}\` service`);
  return effectiveMounts(block).filter((mount) => CONFIG_VOLUMES.includes(mount.source));
}

/** The instance file a service `.`-sources before exec'ing, if it sources one. */
function sourcedFile(block: string): string | null {
  return /(?:^|[\s&'])\. (\/var\/lib\/aflow\/\S+\.env)/.exec(block)?.[1] ?? null;
}

const SERVICES = serviceBlocks();

describe('appliance compose network isolation', () => {
  it('classifies every service, so a new one cannot inherit the flat network', () => {
    expect([...SERVICES.keys()].sort()).toEqual(Object.keys(EXPECTED_NETWORKS).sort());
  });

  it('defines both networks', () => {
    const networks = section('networks');
    expect(networks).toMatch(/^ {2}backend:$/m);
    expect(networks).toMatch(/^ {2}frontend:$/m);
  });

  it.each(Object.entries(EXPECTED_NETWORKS))('attaches %s to %s', (service, expected) => {
    const block = SERVICES.get(service);
    if (block === undefined) throw new Error(`no \`${service}\` service`);
    expect([...effectiveNetworks(block)].sort()).toEqual([...expected].sort());
  });

  it('keeps the published processes off every datastore network', () => {
    for (const store of ['postgres', 'redis']) {
      const storeNetworks = effectiveNetworks(SERVICES.get(store) ?? '');
      for (const published of ['web', 'mcp']) {
        const reachable = effectiveNetworks(SERVICES.get(published) ?? '');
        expect(reachable.filter((net) => storeNetworks.includes(net))).toEqual([]);
      }
    }
  });

  it('leaves the API reachable by name from the processes that call it', () => {
    const apiNetworks = effectiveNetworks(SERVICES.get('api') ?? '');
    for (const [service, variable] of [
      ['web', 'API_URL'],
      ['mcp', 'AFLOW_API_URL'],
    ] as const) {
      const block = SERVICES.get(service) ?? '';
      expect(block).toContain(`${variable}: http://api:3000`);
      expect(effectiveNetworks(block).some((net) => apiNetworks.includes(net))).toBe(true);
    }
  });

  it('leaves the datastores reachable by name from the API', () => {
    const apiNetworks = effectiveNetworks(SERVICES.get('api') ?? '');
    expect(ANCHOR).toContain('postgres://phoenix:phoenix@postgres:5432/phoenix');
    expect(ANCHOR).toContain('redis://redis:6379');
    for (const store of ['postgres', 'redis']) {
      const storeNetworks = effectiveNetworks(SERVICES.get(store) ?? '');
      expect(storeNetworks.some((net) => apiNetworks.includes(net))).toBe(true);
    }
  });
});

describe('appliance compose mount isolation', () => {
  it.each(Object.entries(EXPECTED_CONFIG_MOUNTS))(
    'gives %s only the config volumes it uses',
    (service, expected) => {
      expect(configMounts(service)).toEqual(expected);
    },
  );

  // The file carrying both secrets is readable by anything that mounts it, at
  // any point after start, whatever the process dropped from its environment.
  it('keeps the file holding both secrets away from the services using one', () => {
    for (const service of ['worker', 'web', 'mcp']) {
      expect(configMounts(service).map((mount) => mount.source)).not.toContain('instance_config');
    }
  });

  it('lets only the one-shots write a config volume', () => {
    // `instance-init` establishes the instance's secrets and the cuts derived
    // from them; `bootstrap` re-cuts them once the database exists. Everything
    // that serves reads.
    const writers = ['instance-init', 'bootstrap'];
    for (const service of Object.keys(EXPECTED_CONFIG_MOUNTS)) {
      if (writers.includes(service)) continue;
      expect(configMounts(service).filter((mount) => !mount.readOnly)).toEqual([]);
    }
  });

  it('sources each file out of a volume that service mounts', () => {
    for (const service of ['api', 'worker', 'web']) {
      const file = sourcedFile(SERVICES.get(service) ?? '');
      if (file === null) throw new Error(`\`${service}\` no longer sources an instance file`);
      expect(configMounts(service).map((mount) => mount.target)).toContain(dirname(file));
    }
  });

  // Bootstrap writes the cuts, and a directory it was not told about is a file
  // the reader would source and find missing.
  it('writes each cut into the directory its reader mounts', () => {
    const bootstrap = SERVICES.get('bootstrap') ?? '';
    for (const [service, directoryVar] of Object.entries(AUDIENCE_DIRECTORY_VARS)) {
      const file = sourcedFile(SERVICES.get(service) ?? '');
      if (file === null) throw new Error(`\`${service}\` no longer sources an instance file`);
      expect(bootstrap).toContain(`${directoryVar}: ${dirname(file)}`);
    }
  });

  // Compose names the paths; bootstrap decides what it writes. A rename on
  // either side leaves a service sourcing a file nothing produces.
  it('sources the names bootstrap cuts', () => {
    for (const [service, directoryVar] of Object.entries(AUDIENCE_DIRECTORY_VARS)) {
      const file = sourcedFile(SERVICES.get(service) ?? '');
      if (file === null) throw new Error(`\`${service}\` no longer sources an instance file`);
      expect(INSTANCE_CONFIG_SOURCE).toContain(`'${basename(file)}'`);
      expect(INSTANCE_CONFIG_SOURCE).toContain(`'${directoryVar}'`);
    }
  });
});

describe('appliance compose environment isolation', () => {
  it('withholds the instance secret from the worker', () => {
    const worker = SERVICES.get('worker') ?? '';
    expect(worker).toContain('unset PHOENIX_INSTANCE_SECRET');
    expect(worker).not.toContain('export PHOENIX_INSTANCE_SECRET');
  });

  it('withholds the credential-wrapping key from the web process', () => {
    const web = SERVICES.get('web') ?? '';
    expect(web).toContain('unset CREDENTIAL_ENCRYPTION_KEY');
    expect(web).not.toContain('export CREDENTIAL_ENCRYPTION_KEY');
  });

  /**
   * The service holding the Docker socket is the one that must hold least, and
   * the anchor it merges hands every service `env_file: .env.local` — where an
   * operator keeps model-provider keys and may pin the instance secret and the
   * wrapping key besides. The other two services unset those by name; this one
   * declines the file, which is the only form that also covers a key nobody
   * thought to name.
   */
  it('gives the compute service no env file to read', () => {
    const compute = SERVICES.get('compute') ?? '';
    // Directives only: the prose above them names the file it declines.
    const directives = compute
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(directives).toContain('env_file: []');
    expect(directives).not.toContain('.env.local');
  });

  it('refuses a sandbox path that cannot mean the same thing on both sides', () => {
    const compute = SERVICES.get('compute') ?? '';
    // Absolute, checked before the exec that would otherwise inherit it.
    expect(compute).toContain('PHOENIX_SANDBOX_HOST_DIR');
    expect(compute.indexOf('must be an absolute host path')).toBeLessThan(
      compute.indexOf('exec node'),
    );
  });

  it('unsets before the exec that hands the environment on', () => {
    for (const service of ['worker', 'web']) {
      const command = /'\. \/var\/lib\/aflow\/[^']*'/.exec(SERVICES.get(service) ?? '')?.[0];
      if (command === undefined) throw new Error(`\`${service}\` no longer sources its own file`);
      expect(command.indexOf('unset ')).toBeLessThan(command.indexOf('exec '));
    }
  });
});

/**
 * The runtime processes resolve a public web origin at startup and refuse to
 * run without one, rather than putting a link that cannot be right into an
 * agent prompt. An appliance that omits it does not fail visibly: the launcher
 * restarts the executor on a timer while agent turns fail as internal errors.
 * The published port is the only place the origin is known, so the anchor every
 * runtime process inherits is where it has to be declared.
 */
describe('appliance compose web origin', () => {
  /** Read from the resolver rather than restated, so renaming a key fails here. */
  const acceptedKeys = [
    ...readFileSync(join(REPO_ROOT, 'packages/lib/src/webBaseUrl.ts'), 'utf8').matchAll(
      /const ENV_KEYS = \[([^\]]+)\]/g,
    ),
  ]
    .flatMap((match) => [...(match[1] ?? '').matchAll(/'([A-Z_]+)'/g)])
    .map((match) => match[1] as string);

  it('reads the accepted names off the resolver', () => {
    expect(acceptedKeys).toContain('WEB_BASE_URL');
  });

  it('declares an origin on the anchor every runtime process inherits', () => {
    const declared = acceptedKeys.filter((key) => new RegExp(`^\\s+${key}:`, 'm').test(ANCHOR));
    expect(declared).not.toEqual([]);
  });

  /**
   * `localhost` rather than the `127.0.0.1` its sibling keys use: this origin
   * is the one a person reads in a link and clicks, while `API_BASE_URL`
   * addresses the API between processes. The browser reaches either, because
   * the CORS and realtime origin lists name both spellings.
   */
  it('points it at the published web port, by the name a person would type', () => {
    const declared = acceptedKeys
      .map((key) => new RegExp(`^\\s+${key}: (.+)$`, 'm').exec(ANCHOR)?.[1]?.trim())
      .filter((value): value is string => value !== undefined);
    expect(declared).not.toEqual([]);
    for (const value of declared) {
      expect(value).toBe('http://localhost:${AFLOW_WEB_PORT:-3001}');
    }
  });
});

/**
 * Contract: one image, built once.
 *
 * Every application service runs the same image. Compose builds per service,
 * not per image, so a build section on more than one of them starts that many
 * concurrent builds of identical content: from a cold cache each repeats the
 * whole dependency install — enough to exhaust the Docker VM disk before the
 * first boot — and they then race to export the same tag, which fails for
 * whichever loses.
 */

/** What each service runs, after the anchor is merged. */
const EXPECTED_IMAGE: Record<string, string> = {
  'instance-init': '*image',
  postgres: 'pgvector/pgvector:pg16',
  redis: 'redis:7-alpine',
  migrate: '*image',
  bootstrap: '*image',
  api: '*image',
  worker: '*image',
  compute: '*image',
  web: '*image',
  mcp: '*image',
};

function declaredImage(block: string, indent: number): string | null {
  return new RegExp(`^ {${indent}}image: (\\S+)$`, 'm').exec(block)?.[1] ?? null;
}

function effectiveImage(block: string): string | null {
  const own = declaredImage(block, 4);
  if (own !== null) return own;
  if (!block.includes('<<: *runtime')) return null;
  return declaredImage(ANCHOR, 2);
}

/**
 * Contract: the image creates every directory a volume mounts at.
 *
 * A named volume takes its ownership from the image's mount point. One the
 * image never created arrives owned by root, and the non-root runtime cannot
 * write the file it is supposed to generate on first boot — a failure that
 * appears only on a fresh volume, which is to say only for a new operator.
 */
describe('appliance volume mount points', () => {
  it('creates and owns every mounted aflow directory in the image', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const created = new Set(
      [...dockerfile.matchAll(/\/var\/lib\/aflow\/([a-z]+)/g)].map((m) => m[1] as string),
    );

    const mounted = new Set(
      [...COMPOSE.matchAll(/:\/var\/lib\/aflow\/([a-z]+)/g)].map((m) => m[1] as string),
    );

    const missing = [...mounted].filter((dir) => !created.has(dir)).sort();
    expect(missing).toEqual([]);
  });
});

describe('appliance compose image build', () => {
  /** The service that owns the build must start before any other uses it. */
  const BUILDER = 'instance-init';

  it('classifies every service, so a new one cannot inherit an image silently', () => {
    expect([...SERVICES.keys()].sort()).toEqual(Object.keys(EXPECTED_IMAGE).sort());
  });

  it.each(Object.entries(EXPECTED_IMAGE))('runs %s from %s', (service, expected) => {
    const block = SERVICES.get(service);
    if (block === undefined) throw new Error(`no \`${service}\` service`);
    expect(effectiveImage(block)).toBe(expected);
  });

  it('declares the build on exactly one service, the root of the dependency chain', () => {
    const declaring = [...SERVICES]
      .filter(([, block]) => /^ {4}build:/m.test(block))
      .map(([service]) => service);
    expect(declaring).toEqual([BUILDER]);
  });
});
