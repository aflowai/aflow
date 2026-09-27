/**
 * Configuring a coding harness on this machine.
 *
 * Discovery finds what is installed; this writes what is allowed. The two are
 * kept apart on purpose — finding `claude` on PATH says the operator could run
 * it, never that this instance may — so nothing here happens without the
 * operator naming a harness.
 *
 * Egress is granted a host at a time, and the command prints the hosts a run
 * was refused rather than offering a list to accept wholesale. A harness that
 * reaches a telemetry sink and a package registry alongside its model API
 * should be a thing the operator sees and decides about, not a default.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { HostPolicySchema } from './bindings.js';
import { LocalMcpServerSchema } from './localMcpServers.js';
import { discoverHarnesses } from './harnessDiscovery.js';
import { HarnessProfileSchema, type HarnessProfile } from './harnessProfiles.js';
import { serializePolicy, writePolicyAtomically } from './policyFile.js';

// The same resolution `connect` uses. Disagreeing about where the policy lives
// meant one command wrote a file the other never read.
const HOST_DIR = process.env['PHOENIX_HOST_DIR']?.trim() ?? resolve(homedir(), '.aflow');
const POLICY_PATH = resolve(HOST_DIR, 'host-policy.json');

function usage(): never {
  console.error(
    'Usage:\n' +
      '  harness list                       What is installed here, and what is configured.\n' +
      '  harness add <id> [options]         Allow a discovered harness to run.\n' +
      '  harness allow <id> <host>...       Let a harness reach these hosts.\n' +
      '  harness remove <id>                Stop allowing it.\n' +
      '  harness mcp <id> <command...>      Allow an MCP server to run here.\n' +
      '  harness mcp-remove <id>            Stop allowing it.\n' +
      '  harness tools <path>...            Let commands read where your tools are installed.\n' +
      '  harness tools --clear              Forget them.\n\n' +
      'Options for `add`:\n' +
      '  --executable <path>   Override what discovery found.\n' +
      '  --credential <cmd>    Shell-free command printing the credential, comma-separated.\n' +
      '  --credential-json <path>  Field to take when that command prints JSON.\n' +
      '  --credential-env <NAME>   Environment variable the harness reads it from.\n\n' +
      'Options for `mcp`:\n' +
      '  --binding <id>        The connected folder it runs in. Required.\n' +
      '  --read <path,path>    Paths outside that folder it needs to read — where it is installed.\n\n' +
      'A harness starts with no egress. Run it once, see which hosts it was refused,\n' +
      'and allow the ones the work needs.',
  );
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadPolicy(): Promise<ReturnType<typeof HostPolicySchema.parse>> {
  const raw = await readFile(POLICY_PATH, 'utf8').catch(
    () => '{"version":1,"bindings":[],"harnesses":[]}',
  );
  return HostPolicySchema.parse(JSON.parse(raw));
}

async function savePolicy(policy: ReturnType<typeof HostPolicySchema.parse>): Promise<void> {
  await mkdir(HOST_DIR, { recursive: true, mode: 0o700 });
  await writePolicyAtomically(POLICY_PATH, serializePolicy(policy));
}

function describe(profile: HarnessProfile): string {
  const egress =
    profile.allowedDomains.length === 0
      ? 'reaches nothing'
      : `reaches ${profile.allowedDomains.join(', ')}`;
  const credential = profile.credential ? `, credential via ${profile.credential.env}` : '';
  const named = profile.label === undefined ? '' : ` (${profile.label})`;
  return `  ${profile.id}${named} — ${profile.executable}, ${egress}${credential}`;
}

async function setToolPaths(paths: string[]): Promise<void> {
  const policy = await loadPolicy();
  if (paths.includes('--clear')) {
    policy.toolPaths = [];
    await savePolicy(policy);
    console.log('Commands can no longer read anything outside their binding.');
    return;
  }
  const resolved = paths.map((p) => resolve(p));
  policy.toolPaths = [...new Set([...policy.toolPaths, ...resolved])];
  await savePolicy(policy);
  console.log('Commands may now also read:');
  for (const p of policy.toolPaths) console.log(`  ${p}`);
  console.log(
    '\nRead-only, and only for commands run in a folder you connected with --run.\n' +
      'Home stays denied as a region — this carves out exactly what you named.',
  );
}

async function addMcpServer(id: string, command: string[]): Promise<void> {
  const [executable, ...args] = command;
  if (executable === undefined) {
    console.error('Give the command to run, after the id.');
    process.exit(1);
  }
  const bindingId = arg('binding');
  if (bindingId === undefined) {
    console.error(
      'Give the folder it runs in: --binding <id>. A sandbox is always compiled from some\n' +
        'binding, so leaving it out would let the caller choose one instead of you.',
    );
    process.exit(1);
  }
  const readPaths = (arg('read') ?? '').split(',').filter((p) => p !== '');
  const server = LocalMcpServerSchema.parse({
    id,
    executable,
    args,
    bindingId,
    authPaths: readPaths,
  });

  const policy = await loadPolicy();
  policy.mcpServers = [...policy.mcpServers.filter((m) => m.id !== id), server];
  await savePolicy(policy);

  console.log(`This machine will run \`${id}\` as: ${executable} ${args.join(' ')}`);
  console.log(`  It runs inside \`${server.bindingId}\` and reaches nothing outside it.`);
  if (readPaths.length === 0) {
    console.log(
      '  If it is installed under your home directory it cannot read its own code yet:\n' +
        `  home is denied. Add where it lives with --read <path>.`,
    );
  }
  console.log(
    '\nThe workspace does not know about it yet. Tell it, so an agent can find it:\n' +
      `  connect <folder> --space <slug> --mcp ${id}`,
  );
}

async function removeMcpServer(id: string): Promise<void> {
  const policy = await loadPolicy();
  if (!policy.mcpServers.some((m) => m.id === id)) {
    console.error(`'${id}' is not configured here.`);
    process.exit(1);
  }
  policy.mcpServers = policy.mcpServers.filter((m) => m.id !== id);
  await savePolicy(policy);
  console.log(`\`${id}\` will no longer run here.`);
}

async function list(): Promise<void> {
  const [policy, discovered] = await Promise.all([loadPolicy(), discoverHarnesses()]);

  console.log('Configured on this machine:');
  if (policy.harnesses.length === 0) console.log('  (none)');
  else for (const profile of policy.harnesses) console.log(describe(profile));

  if (policy.mcpServers.length > 0) {
    console.log('\nMCP servers configured on this machine:');
    for (const server of policy.mcpServers) {
      console.log(`  ${server.id} — ${server.executable}, in ${server.bindingId}`);
    }
  }

  const unconfigured = discovered.filter((d) => !policy.harnesses.some((h) => h.id === d.id));
  if (unconfigured.length > 0) {
    console.log('\nInstalled but not configured:');
    for (const found of unconfigured) {
      console.log(`  ${found.id} — ${found.label} ${found.version}`);
      console.log(`      aflow harness add ${found.id}`);
    }
  }
}

async function add(id: string): Promise<void> {
  const discovered = (await discoverHarnesses()).find((d) => d.id === id);
  const executable = arg('executable') ?? discovered?.executable;
  if (executable === undefined) {
    console.error(
      `Could not find '${id}' on this machine. Install it, or pass --executable with its path.`,
    );
    process.exit(1);
  }

  const credentialCommand = arg('credential');
  const credentialEnv = arg('credential-env');
  if ((credentialCommand === undefined) !== (credentialEnv === undefined)) {
    console.error(
      '--credential and --credential-env go together: the command, and where it lands.',
    );
    process.exit(1);
  }

  const jsonPath = arg('credential-json');
  const profile = HarnessProfileSchema.parse({
    id,
    executable,
    ...(discovered
      ? {
          label: discovered.label,
          promptArgs: discovered.suggested.promptArgs,
          args: discovered.suggested.args,
          output: discovered.suggested.output,
          turnsArgs: discovered.suggested.turnsArgs,
          modelArgs: discovered.suggested.modelArgs,
          sessionArgs: discovered.suggested.sessionArgs,
          resumeArgs: discovered.suggested.resumeArgs,
          authPaths: discovered.suggested.authPaths,
          writePaths: discovered.suggested.writePaths,
          ...(discovered.suggested.configDirEnv !== undefined
            ? { configDirEnv: discovered.suggested.configDirEnv }
            : {}),
        }
      : {}),
    ...(credentialCommand !== undefined && credentialEnv !== undefined
      ? {
          credential: {
            command: credentialCommand.split(','),
            env: credentialEnv,
            ...(jsonPath !== undefined ? { jsonPath } : {}),
          },
        }
      : {}),
  });

  const policy = await loadPolicy();
  const existing = policy.harnesses.find((h) => h.id === id);
  // Egress and a credential source survive a re-add. Both were configured
  // deliberately — egress host by host, a credential once and carefully — and
  // silently dropping either leaves a working harness broken with no message.
  if (existing) {
    profile.allowedDomains = existing.allowedDomains;
    if (profile.credential === undefined && existing.credential !== undefined) {
      profile.credential = existing.credential;
    }
  }
  policy.harnesses = [...policy.harnesses.filter((h) => h.id !== id), profile];
  await savePolicy(policy);

  console.log(`Configured \`${id}\`.`);
  console.log(describe(profile));
  if (profile.allowedDomains.length === 0) {
    console.log(
      '\nIt reaches nothing yet. Run it once — the run reports every host it was refused,\n' +
        `then: aflow harness allow ${id} <host>`,
    );
  }
}

async function allow(id: string, hosts: string[]): Promise<void> {
  const policy = await loadPolicy();
  const profile = policy.harnesses.find((h) => h.id === id);
  if (!profile) {
    console.error(`'${id}' is not configured here. Add it first: aflow harness add ${id}`);
    process.exit(1);
  }
  profile.allowedDomains = [...new Set([...profile.allowedDomains, ...hosts])];
  await savePolicy(policy);
  console.log(`\`${id}\` now reaches ${profile.allowedDomains.join(', ')}.`);
}

async function remove(id: string): Promise<void> {
  const policy = await loadPolicy();
  if (!policy.harnesses.some((h) => h.id === id)) {
    console.error(`'${id}' is not configured here.`);
    process.exit(1);
  }
  policy.harnesses = policy.harnesses.filter((h) => h.id !== id);
  await savePolicy(policy);
  console.log(`\`${id}\` will no longer run here.`);
}

async function main(): Promise<void> {
  const [, , command, id, ...rest] = process.argv;

  if (command === 'list') {
    await list();
    return;
  }
  if (id === undefined) usage();

  if (command === 'add') {
    await add(id);
    return;
  }
  if (command === 'remove') {
    await remove(id);
    return;
  }
  if (command === 'tools') {
    const paths = [id, ...rest].filter((a) => a !== '');
    if (paths.length === 0) usage();
    await setToolPaths(paths);
    return;
  }
  if (command === 'mcp') {
    // Dropping the flags is not enough — their values are ordinary words, and
    // filtering only what starts with `--` left `--binding hb_project` putting
    // `hb_project` on the server's command line.
    const commandArgs: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (token === undefined) continue;
      if (token.startsWith('--')) {
        i += 1;
        continue;
      }
      commandArgs.push(token);
    }
    if (commandArgs.length === 0) usage();
    await addMcpServer(id, commandArgs);
    return;
  }
  if (command === 'mcp-remove') {
    await removeMcpServer(id);
    return;
  }
  if (command === 'allow') {
    const hosts = rest.filter((h) => !h.startsWith('--'));
    if (hosts.length === 0) usage();
    await allow(id, hosts);
    return;
  }
  usage();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
