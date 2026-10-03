/**
 * Pairing this machine with an appliance.
 *
 * Run once, by the operator, from the machine that will do the work. It asks
 * the appliance for the material a host executor needs and writes it where the
 * executor looks — outside any path a job can write, so a job cannot grant
 * itself a binding by editing the file that lists them.
 *
 * Bindings are not created here. Pairing establishes who this machine is to the
 * appliance; what it may reach is a separate decision the operator makes per
 * folder, and conflating the two would make connecting a project imply trusting
 * every future one.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { HostPolicySchema } from './bindings.js';
import { resolveHostPolicyPath } from './hostDir.js';
import { serializePolicy, writePolicyAtomically } from './policyFile.js';

const POLICY_PATH = resolveHostPolicyPath();
const HOST_DIR = dirname(POLICY_PATH);

interface PairingMaterial {
  redisUrl: string;
  redisUsername: string;
  redisPassword: string;
  bindings: Array<{
    id: string;
    label: string;
    root: string;
    mode: string;
    allowsExecution: boolean;
  }>;
}

function usage(): never {
  console.error(
    'Usage: AFLOW_PAIR_SECRET=<instance secret> pair --api <url>\n\n' +
      "  --api     Where the appliance's API answers, e.g. http://127.0.0.1:3000\n\n" +
      '  The instance secret arrives in AFLOW_PAIR_SECRET, or on stdin when that\n' +
      '  is unset. It is in `instance.env` on the appliance, and the appliance is\n' +
      '  the only thing that should ever hold it.',
  );
  process.exit(2);
}

/**
 * Never from argv.
 *
 * The instance secret pairs a machine, and a command line is not private: it
 * lands in shell history and is readable by every process on the machine for as
 * long as this one runs. An environment variable is read by this process and
 * nobody else's `ps`; stdin is not stored at all, which is why it is what an
 * operator typing the secret gets.
 */
async function readSecret(): Promise<string> {
  const fromEnv = process.env['AFLOW_PAIR_SECRET'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim();
  if (process.stdin.isTTY) {
    console.error('Paste the instance secret, then press Enter:');
  }
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  const piped = chunks.join('');
  const secret = piped.trim();
  if (secret === '') usage();
  return secret;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const api = arg('api');
  if (api === undefined) usage();
  if (process.argv.includes('--secret')) {
    console.error(
      'The instance secret is not taken on the command line, where it would be left in shell\n' +
        'history and readable by every process here. Set AFLOW_PAIR_SECRET, or pipe it in.',
    );
    process.exit(2);
  }
  const secret = await readSecret();

  const response = await fetch(new URL('/v1/host/pair', api), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `The appliance refused to pair (${String(response.status)}). ${detail.slice(0, 300)}`,
    );
  }
  const material = (await response.json()) as PairingMaterial;

  await mkdir(HOST_DIR, { recursive: true, mode: 0o700 });

  const envPath = join(HOST_DIR, 'host.env');
  const url = new URL(material.redisUrl);
  url.username = material.redisUsername;
  url.password = material.redisPassword;
  await writeFile(envPath, `REDIS_URL='${url.toString()}'\n`, { mode: 0o600 });
  await chmod(envPath, 0o600);

  // An existing policy is left alone: re-pairing after a password rotation
  // must not silently drop the folders the operator already connected.
  const existing = await readFile(POLICY_PATH, 'utf8').catch(() => null);
  if (existing === null) {
    await writePolicyAtomically(POLICY_PATH, serializePolicy({ version: 1, bindings: [] }));
  } else {
    HostPolicySchema.parse(JSON.parse(existing));
  }

  console.log(`Paired. Credential in ${envPath}, bindings in ${POLICY_PATH}.`);

  // The two halves refer to each other by id, and a mismatch is silent by
  // construction: the appliance thinks a folder is connected, the machine has
  // never heard of it, and a run against it fails much later with a refusal
  // that looks like a bug. Pairing is the one moment both lists are in hand.
  const local = HostPolicySchema.parse(
    JSON.parse((await readFile(POLICY_PATH, 'utf8')) || '{"version":1,"bindings":[]}'),
  );
  const localIds = new Set(local.bindings.map((b) => b.id));
  const declared = material.bindings;
  const missing = declared.filter((b) => !localIds.has(b.id));
  const extra = local.bindings.filter((b) => !declared.some((d) => d.id === b.id));

  if (declared.length === 0 && local.bindings.length === 0) {
    console.log(
      'Nothing is reachable yet: connect a folder in the workspace, add the same id to the ' +
        'policy file, then start the executor.',
    );
  }
  for (const binding of missing) {
    console.log(
      `The workspace expects \`${binding.id}\` (${binding.root}), which this machine does not ` +
        'offer. Add it to the policy file or it reaches nothing.',
    );
  }
  for (const binding of extra) {
    console.log(
      `This machine offers \`${binding.id}\`, which no workspace has connected. It is unused ` +
        'until one does.',
    );
  }
  if (declared.length > 0 && missing.length === 0 && extra.length === 0) {
    console.log(`Both halves agree on ${String(declared.length)} folder(s).`);
  }
}

main().catch((error: unknown) => {
  console.error(`Pairing failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
