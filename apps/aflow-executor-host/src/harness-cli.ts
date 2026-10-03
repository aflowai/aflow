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
import { dirname, resolve } from 'node:path';

import { resolveBranchPolicy } from '@aflow/schemas';

import { HostPolicySchema } from './bindings.js';
import { appliancePortWarning, parseLocalPorts } from './browserLocalPorts.js';
import { LocalMcpServerSchema } from './localMcpServers.js';
import { describeHarnessConcurrency, withHarnessConcurrency } from './harnessConcurrency.js';
import { discoverHarnesses, knownMcpArgs } from './harnessDiscovery.js';
import {
  HarnessProfileSchema,
  MCP_CONFIG_PLACEHOLDER,
  type HarnessProfile,
} from './harnessProfiles.js';
import { resolveHostPolicyPath } from './hostDir.js';
import { serializePolicy, writePolicyAtomically } from './policyFile.js';
import { checksChangeFromArgs, describeChecks, withChecks } from './folderChecks.js';
import { describePushApproval, withPushApproval } from './pushApproval.js';
import { describeFolderSandbox, sandboxVerb } from './sandboxPosture.js';

const POLICY_PATH = resolveHostPolicyPath();
const HOST_DIR = dirname(POLICY_PATH);

function usage(): never {
  console.error(
    'Usage:\n' +
      '  harness list                       What is installed here, and what is configured.\n' +
      '  harness add <id> [options]         Allow a discovered harness to run.\n' +
      '  harness allow <id> <host>...       Let a harness reach these hosts.\n' +
      '  harness model <id> <model>         Run this model when a task names none.\n' +
      "  harness model <id> --clear         Run the harness's own default instead.\n" +
      '  harness browser <id> [<arg>...]    How it is handed a browser: the arguments that pass\n' +
      '                                     an MCP configuration file, with {mcpConfig} where\n' +
      '                                     its path goes. With none, those measured for it.\n' +
      '  harness browser <id> --clear       Hand it no browser.\n' +
      '  harness browser-ports <id> <port>...\n' +
      '                                     Ports on this machine its ephemeral browser may load,\n' +
      '                                     on loopback only.\n' +
      '  harness browser-ports <id> --clear Let it load none.\n' +
      '  harness concurrency <n>            Run at most this many coding agents at once.\n' +
      '  harness concurrency --clear        Run the default number instead.\n' +
      '  harness push-approval <folder> <always|never|unless-unreviewed>\n' +
      '                                     When a publication from a folder asks before pushing.\n' +
      '  harness checks <folder> [--timeout-minutes <n>] -- <program> [args...]\n' +
      '                                     What a publication from a folder runs before it\n' +
      '                                     scans and pushes, from the repository root.\n' +
      '  harness checks <folder> --timeout-minutes <n>\n' +
      '                                     How long those checks may run.\n' +
      '  harness checks <folder> --clear    Run none.\n' +
      '  harness sandbox <folder> <open|confined>\n' +
      '                                     What its coding agents and checks run under.\n' +
      '  harness remove <id>                Stop allowing it.\n' +
      '  harness mcp <id> <command...>      Allow an MCP server to run here.\n' +
      '  harness mcp-remove <id>            Stop allowing it.\n' +
      '  harness tools <path>...            Let commands read where your tools are installed.\n' +
      '  harness tools --clear              Forget them.\n\n' +
      'Options for `add`:\n' +
      '  --executable <path>   Override what discovery found.\n' +
      '  --credential <cmd>    Shell-free command printing the credential, comma-separated.\n' +
      '  --credential-json <path>  Field to take when that command prints JSON.\n' +
      '  --credential-env <NAME>   Environment variable the harness reads it from.\n' +
      '  --model <id>          Model to run when a task names none, as the harness spells it.\n\n' +
      'Options for `mcp`:\n' +
      '  --binding <id>        The connected folder it runs in. Required.\n' +
      '  --read <path,path>    Paths outside that folder it needs to read — where it is installed.\n\n' +
      'In a confined folder a harness starts with no egress. Run it once, see which hosts\n' +
      'it was refused, and allow the ones the work needs.',
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
  const model = profile.model === undefined ? 'its default model' : `model ${profile.model}`;
  const ports =
    profile.browserLocalPorts.length === 0
      ? ''
      : ` on loopback ports ${profile.browserLocalPorts.join(', ')}`;
  const browser = profile.mcpArgs.length === 0 ? ', no browser' : `, takes a browser${ports}`;
  return `  ${profile.id}${named} — ${profile.executable}, ${model}, ${egress}${credential}${browser}`;
}

// Refused here rather than at the first run: a profile model the harness has no
// argument for fails every task that names no model of its own.
function refuseUnplaceableModel(profile: HarnessProfile, model: string): void {
  if (profile.modelArgs.length > 0) return;
  console.error(
    `'${profile.id}' takes no model argument on this machine, so '${model}' could never be\n` +
      'passed to it. Leave the model unset and it runs its own default.',
  );
  process.exit(1);
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
  console.log(`This machine ${describeHarnessConcurrency(policy)}.`);

  if (policy.mcpServers.length > 0) {
    console.log('\nMCP servers configured on this machine:');
    for (const server of policy.mcpServers) {
      console.log(`  ${server.id} — ${server.executable}, in ${server.bindingId}`);
    }
  }

  const pushing = policy.bindings.flatMap((b) =>
    b.branchPolicy === undefined ? [] : [{ id: b.id, branchPolicy: b.branchPolicy }],
  );
  if (pushing.length > 0) {
    console.log('\nFolders that push:');
    for (const { id, branchPolicy } of pushing) {
      console.log(
        `  ${id} — under ${branchPolicy.branchPrefix}, ` +
          describePushApproval(resolveBranchPolicy(branchPolicy).pushApproval) +
          (branchPolicy.pushApproval === undefined ? ', the default' : '') +
          `; ${describeChecks(branchPolicy)}`,
      );
    }
  }

  const running = policy.bindings.filter((b) => b.allowsExecution);
  if (running.length > 0) {
    console.log('\nFolders that run commands:');
    for (const binding of running) {
      console.log(`  ${binding.id} — ${describeFolderSandbox(binding)}`);
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
  const model = arg('model');
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
          mcpArgs: discovered.suggested.mcpArgs,
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
    ...(model !== undefined ? { model } : {}),
  });

  const policy = await loadPolicy();
  const existing = policy.harnesses.find((h) => h.id === id);
  // Egress, a credential source and a model survive a re-add. Each was
  // configured deliberately — egress host by host, a credential once and
  // carefully — and silently dropping one changes a working harness with no
  // message.
  if (existing) {
    profile.allowedDomains = existing.allowedDomains;
    profile.browserLocalPorts = existing.browserLocalPorts;
    if (profile.credential === undefined && existing.credential !== undefined) {
      profile.credential = existing.credential;
    }
    if (profile.mcpArgs.length === 0) profile.mcpArgs = existing.mcpArgs;
    if (model === undefined && existing.model !== undefined) {
      if (profile.modelArgs.length > 0) profile.model = existing.model;
      else {
        console.log(
          `'${id}' now takes no model argument, so its model '${existing.model}' was dropped.`,
        );
      }
    }
  }
  if (model !== undefined) refuseUnplaceableModel(profile, model);
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

async function setModel(id: string, model: string): Promise<void> {
  const policy = await loadPolicy();
  const profile = policy.harnesses.find((h) => h.id === id);
  if (!profile) {
    console.error(`'${id}' is not configured here. Add it first: aflow harness add ${id}`);
    process.exit(1);
  }
  if (model === '--clear') {
    delete profile.model;
    await savePolicy(policy);
    console.log(`\`${id}\` now runs its own default model when a task names none.`);
    return;
  }
  const parsed = HarnessProfileSchema.safeParse({ ...profile, model });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    console.error(`'${model}' cannot be saved as the model for '${id}': ${problems}`);
    process.exit(1);
  }
  refuseUnplaceableModel(parsed.data, model);
  policy.harnesses = policy.harnesses.map((h) => (h.id === id ? parsed.data : h));
  await savePolicy(policy);
  console.log(`\`${id}\` now runs ${model} when a task names none.`);
}

async function setMcpArgs(id: string, given: readonly string[]): Promise<void> {
  const policy = await loadPolicy();
  const profile = policy.harnesses.find((h) => h.id === id);
  if (!profile) {
    console.error(`'${id}' is not configured here. Add it first: aflow harness add ${id}`);
    process.exit(1);
  }
  if (given.length === 1 && given[0] === '--clear') {
    profile.mcpArgs = [];
    await savePolicy(policy);
    console.log(`\`${id}\` is handed no browser; a run asking for one is refused.`);
    return;
  }
  const mcpArgs = given.length > 0 ? [...given] : knownMcpArgs(id);
  if (mcpArgs === undefined) {
    console.error(
      `No MCP arguments were measured for '${id}'. Give them, with ${MCP_CONFIG_PLACEHOLDER} ` +
        `where the configuration file's path goes:\n  aflow harness browser ${id} <arg>...`,
    );
    process.exit(1);
  }
  const slots = mcpArgs.filter((arg) => arg === MCP_CONFIG_PLACEHOLDER).length;
  if (slots !== 1) {
    console.error(
      `The arguments must carry ${MCP_CONFIG_PLACEHOLDER} exactly once, where the ` +
        `configuration file's path goes; these carry it ${String(slots)} times.`,
    );
    process.exit(1);
  }
  profile.mcpArgs = mcpArgs;
  await savePolicy(policy);
  console.log(`\`${id}\` is handed a browser as: ${mcpArgs.join(' ')}`);
}

async function setBrowserLocalPorts(id: string, given: readonly string[]): Promise<void> {
  const policy = await loadPolicy();
  const profile = policy.harnesses.find((h) => h.id === id);
  if (!profile) {
    console.error(`'${id}' is not configured here. Add it first: aflow harness add ${id}`);
    process.exit(1);
  }
  if (given.length === 1 && given[0] === '--clear') {
    profile.browserLocalPorts = [];
    await savePolicy(policy);
    console.log(`\`${id}\`'s ephemeral browser now loads nothing on this machine.`);
    return;
  }
  const parsed = parseLocalPorts(given);
  if (!parsed.ok) {
    console.error(`'${parsed.word}' is not a port: give whole numbers from 1 to 65535.`);
    process.exit(1);
  }
  const warning = appliancePortWarning(id, parsed.ports, process.env);
  if (warning !== undefined) console.warn(warning);
  profile.browserLocalPorts = [...new Set([...profile.browserLocalPorts, ...parsed.ports])];
  await savePolicy(policy);
  console.log(
    `\`${id}\`'s ephemeral browser now loads ports ${profile.browserLocalPorts.join(', ')} ` +
      'on loopback — localhost, 127.0.0.1, [::1] — and on no other address of this machine.',
  );
}

async function setHarnessConcurrency(requested: string): Promise<void> {
  const updated = withHarnessConcurrency(await loadPolicy(), requested);
  await savePolicy(updated);
  console.log(`This machine now ${describeHarnessConcurrency(updated)}.`);
}

async function setPushApproval(bindingId: string, requested: string): Promise<void> {
  const updated = withPushApproval(await loadPolicy(), bindingId, requested);
  await savePolicy(updated);
  const posture = updated.bindings.find((b) => b.id === bindingId)?.branchPolicy?.pushApproval;
  if (posture !== undefined) {
    console.log(`A publication from \`${bindingId}\` now ${describePushApproval(posture)}.`);
  }
}

async function setChecks(bindingId: string, args: readonly string[]): Promise<void> {
  const updated = withChecks(await loadPolicy(), bindingId, checksChangeFromArgs(args));
  await savePolicy(updated);
  const branchPolicy = updated.bindings.find((b) => b.id === bindingId)?.branchPolicy;
  if (branchPolicy !== undefined) {
    console.log(`A publication from \`${bindingId}\` now ${describeChecks(branchPolicy)}.`);
  }
}

async function setSandbox(bindingId: string, args: readonly string[]): Promise<void> {
  const { policy, said } = sandboxVerb(await loadPolicy(), bindingId, args);
  await savePolicy(policy);
  console.log(said);
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
  if (command === 'model') {
    const [model] = rest;
    // A flag in the model's place is a mistyped command, not a model name:
    // `harness model claude --model opus` would otherwise store `--model`.
    if (model === undefined || model === '') usage();
    if (model.startsWith('--') && model !== '--clear') usage();
    await setModel(id, model);
    return;
  }
  if (command === 'browser') {
    await setMcpArgs(id, rest);
    return;
  }
  if (command === 'browser-ports') {
    if (rest.length === 0) usage();
    await setBrowserLocalPorts(id, rest);
    return;
  }
  if (command === 'concurrency') {
    await setHarnessConcurrency(id);
    return;
  }
  if (command === 'push-approval') {
    const [posture] = rest;
    if (posture === undefined || posture === '') usage();
    await setPushApproval(id, posture);
    return;
  }
  if (command === 'checks') {
    if (rest.length === 0) usage();
    await setChecks(id, rest);
    return;
  }
  if (command === 'sandbox') {
    await setSandbox(id, rest);
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
