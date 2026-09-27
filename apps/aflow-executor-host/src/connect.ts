/**
 * Connecting a folder, from the machine the folder is on.
 *
 * Both halves in one command, because typing an id twice is how the two halves
 * come to disagree — and a binding whose names differ reaches nothing while
 * both sides believe it is connected.
 *
 * It runs here rather than in the browser because a browser cannot tell anyone
 * where a folder is: a directory picker yields handles and relative names, and
 * every browser withholds the absolute path deliberately. That is the same
 * boundary that stops a web page reading a home directory, and it is not one
 * worth working around.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { createRedisConnection, HOST_INVENTORY_TTL_MS, HOST_MACHINES_KEY } from '@aflow/redis';

import { chooseFolder } from './folderPicker.js';
import { namesInUseFor } from './connectNaming.js';
import { listLocalTools } from './localMcpClient.js';
import { isGitRepository } from './worktree.js';
import {
  createPrompter,
  type Prompter,
  resolveBranchPrefix,
  toolDirectoriesOnPath,
} from './interview.js';
import { serializePolicy, writePolicyAtomically } from './policyFile.js';
import {
  assertRootOutsideRepositoryMetadata,
  type HostBinding,
  HostPolicySchema,
} from './bindings.js';

const HOST_DIR = process.env['PHOENIX_HOST_DIR']?.trim() ?? resolve(homedir(), '.aflow');

interface ConnectMaterial {
  redisUrl: string;
  redisUsername: string;
  redisPassword: string;
  spaceId: string;
  spaceSlug: string;
  /**
   * The name the workspace recorded this folder under, which is the one the
   * machine has to answer for. It is not always the one that was asked for: a
   * name already reaching another workspace's folder is made unique there,
   * where the target space is known.
   */
  binding: { hostBindingId: string };
  /** Every folder the workspace believes is connected, so the two lists can be compared. */
  bindings: Array<{ id: string; root: string }>;
}

function usage(): never {
  console.error(
    'Usage: connect <code> [options]\n\n' +
      '  Run this in the folder you want to connect. The code comes from the\n' +
      '  workspace: Settings → This Computer → Connect a folder.\n\n' +
      '  --folder <path>  Connect this instead of the current directory\n' +
      '  --api <url>      Where the appliance answers (default http://127.0.0.1:3000)\n' +
      "  --id <id>        Name for the folder on this machine (default: the folder's name, made\n" +
      '                   unique per workspace)\n' +
      '  --label <text>   How it is shown (default: the folder name)\n' +
      '  --write          Allow writing, without being asked\n' +
      '  --run            Allow commands, without being asked\n' +
      '  --branch-prefix <p>  Publish to branches under this prefix instead of aflow/ (a git\n' +
      '                   repository with --run)\n' +
      '  --mcp a,b        Offer these MCP servers, without being asked\n' +
      '  --yes            Take every default and ask nothing',
  );
  process.exit(2);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Derived from the folder, so the same name cannot be typed two ways. */
function idFor(root: string): string {
  const base = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `hb_${base.length > 0 ? base : 'folder'}`;
}

/**
 * What the two halves disagree about, said while both lists are in hand.
 *
 * A binding reaches nothing unless the appliance and the machine agree, and
 * every way they can disagree is silent by construction: the failure arrives
 * later, at a job, as a refusal that reads like a defect in the lane. This is
 * the one moment the appliance's list and the machine's are both here.
 *
 * The subtle one is a binding that matches by id on both sides but names no
 * workspace, or names another. Nothing looks wrong — the ids line up, the root
 * is right — and the space check refuses it at use. An id written before the
 * policy recorded a workspace at all leaves exactly that.
 */
/**
 * Whether a host executor on this machine is currently claiming work.
 *
 * Each one republishes an inventory entry well inside its own lifetime, so a
 * live member of that set is a running executor and an expired one is not. Best
 * effort by design: this decides only which sentence to print, and a connect
 * that succeeded must not fail because a status read did.
 */
async function executorIsRunning(redisUrl: string): Promise<boolean> {
  try {
    // Through the shared factory, which is the one place a connection is built
    // — a guard test keeps it that way, and it caught this being an exception.
    const redis = createRedisConnection({ url: redisUrl, connectionName: 'connect-readiness' });
    try {
      // Bounded: this decides one sentence, and a Redis that will not answer
      // must not hold the command that just connected a folder.
      const fresh = await Promise.race([
        redis.zrangebyscore(HOST_MACHINES_KEY, Date.now() - HOST_INVENTORY_TTL_MS, '+inf'),
        new Promise<string[]>((resolve) => {
          setTimeout(() => {
            resolve([]);
          }, 3000);
        }),
      ]);
      return fresh.length > 0;
    } finally {
      redis.disconnect();
    }
  } catch {
    return false;
  }
}

function reportDisagreement(
  prompter: Prompter,
  local: readonly HostBinding[],
  material: ConnectMaterial,
  justConnected: string,
): void {
  const declared = material.bindings;
  for (const binding of declared) {
    if (!local.some((b) => b.id === binding.id)) {
      prompter.say(
        `  Note: the workspace also expects \`${binding.id}\` (${binding.root}), which this ` +
          'machine does not offer. Connect it here too, or it reaches nothing.',
      );
    }
  }
  for (const binding of local) {
    if (binding.id === justConnected) continue;
    if (!declared.some((d) => d.id === binding.id)) {
      prompter.say(
        `  Note: this machine offers \`${binding.id}\`, which no workspace has connected. It is ` +
          'unused until one does.',
      );
      continue;
    }
    if (binding.spaceId === undefined || binding.spaceId === '') {
      prompter.say(
        `  Note: \`${binding.id}\` here records no workspace, so it is refused at use however ` +
          'right it looks. Reconnect it to fix that.',
      );
    } else if (binding.spaceId !== material.spaceId) {
      prompter.say(
        `  Note: \`${binding.id}\` here belongs to a different workspace, so this one cannot ` +
          'reach it.',
      );
    }
  }
}

async function main(): Promise<void> {
  const code = process.argv[2];
  if (code === undefined || code.startsWith('--')) usage();

  const prompter = createPrompter();
  try {
    const api = arg('api') ?? process.env['AFLOW_API_URL']?.trim() ?? 'http://127.0.0.1:3000';
    // Asked for rather than assumed from the working directory. `yarn workspace`
    // runs a script from the package's own folder, so a command launched that
    // way would otherwise offer to connect this executor's source directory —
    // confidently, and to the operator's surprise. A published binary can
    // default to where it was invoked; this cannot, so it asks.
    const explicit = arg('folder');
    if (explicit === undefined && !prompter.interactive) {
      // Nothing to ask and nothing given. Falling back to the working directory
      // here would connect this executor's own source folder, silently and with
      // every grant the flags asked for.
      throw new Error('Which folder? There is no terminal to ask, so pass --folder /path/to/it.');
    }
    let requested = explicit;
    if (requested === undefined) {
      // The dialog first, because picking a folder is what the operating system
      // already does well and what the operator already knows how to do.
      const choice = await chooseFolder('Choose a folder for this workspace to reach');
      if (choice.kind === 'cancelled') {
        prompter.say('Nothing was connected.');
        return;
      }
      requested =
        choice.kind === 'chosen'
          ? choice.path
          : await prompter.askRequired('Which folder should this workspace reach?');
    }
    // `~` is the shell's, and nothing expands it in an answer typed at a prompt.
    const expanded = requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested;
    const root = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    const info = await stat(root).catch(() => null);
    if (info === null) {
      throw new Error(`There is no \`${root}\` on this machine.`);
    }
    // An explicit name is an answer the operator gave; a derived one is this
    // command's suggestion, which only the workspace can make unique.
    const explicitId = arg('id');
    const id = explicitId ?? idFor(root);
    // Refused before anything is asked or sent: the operator learns immediately,
    // rather than after answering three questions about a folder that cannot be
    // connected at all.
    await assertRootOutsideRepositoryMetadata(id, root);

    const assumeYes = flag('yes');
    const explicitMcp = arg('mcp')
      ?.split(',')
      .filter((m) => m !== '');
    if (!assumeYes && !(await prompter.confirm(`Connect ${root}?`, true))) {
      prompter.say('Nothing was connected.');
      return;
    }

    const label = arg('label') ?? basename(root);
    // A flag on the command line is an answer already given; asking again would
    // be theatre. Absent one, the default is the narrower grant.
    const writable =
      flag('write') || (assumeYes ? false : await prompter.confirm('Allow writing?', false));
    const allowsExecution =
      flag('run') || (assumeYes ? false : await prompter.confirm('Allow commands to run?', false));
    const repository = await isGitRepository(root);
    const branchPrefix = resolveBranchPrefix({
      requested: arg('branch-prefix'),
      allowsExecution,
      repository,
      root,
    });

    const policyPath = resolve(HOST_DIR, 'host-policy.json');
    await mkdir(HOST_DIR, { recursive: true, mode: 0o700 });
    const raw = await readFile(policyPath, 'utf8').catch(() => '{"version":1,"bindings":[]}');
    const policy = HostPolicySchema.parse(JSON.parse(raw));

    // Home is denied as a region, so a CLI installed under it is unreachable
    // until the operator says otherwise. That used to mean editing a key they
    // had not heard of, in a file they had never opened. Their own tools,
    // offered by name, make it a keypress.
    if (allowsExecution && !assumeYes) {
      const found = await toolDirectoriesOnPath(process.env, { within: root });
      const fresh = found.filter((tool) => !policy.toolPaths.includes(tool.directory));
      if (fresh.length > 0) {
        prompter.say('');
        prompter.say(
          'Commands run in a sandbox that reads nothing under your home folder, so a tool ' +
            'installed there is found only once its folder is allowed. These folders on your ' +
            'PATH hold tools:',
        );
        for (const tool of fresh) {
          const more = tool.count > 1 ? ` and ${String(tool.count - 1)} more` : '';
          prompter.say(`    ${tool.directory}  (${tool.name}${more})`);
        }
        if (
          await prompter.confirm(
            'Allow commands in connected folders to run the tools in these folders?',
            true,
          )
        ) {
          policy.toolPaths = [...policy.toolPaths, ...fresh.map((t) => t.directory)];
        }
        prompter.say('');
      }
    }

    // Before the token is spent. The space this folder is being connected to is
    // only known once the code is redeemed, but the common collision does not
    // need it: an id on this machine already pointing at a different folder is
    // wrong whichever workspace asked. Checked after redemption, a refusal cost
    // the operator their one-use code and left a row nothing here answers for.
    const differentFolder = policy.bindings.find((b) => b.id === id && b.root !== root);
    if (differentFolder !== undefined) {
      throw new Error(
        `This machine already offers \`${id}\` for ${differentFolder.root}. ` +
          'Connect this one under a different id: add `--id <name>`.',
      );
    }

    // A server is a program, so the folder has to allow commands before one can
    // be offered at all. Asked here because the appliance cannot reach these
    // servers to ask them itself.
    const mcpServers: Array<{
      id: string;
      label: string;
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    }> = [];
    const offerable = allowsExecution ? policy.mcpServers : [];
    for (const server of offerable) {
      const wanted =
        explicitMcp === undefined
          ? await prompter.confirm(`Offer the MCP server \`${server.id}\` from this folder?`, true)
          : explicitMcp.includes(server.id);
      if (!wanted) continue;
      try {
        const tools = await listLocalTools(
          { ...server },
          {
            id,
            root,
            mode: writable ? 'readwrite' : 'read',
            allowsExecution,
            singleFile: info.isFile(),
          } as HostBinding,
          'connect',
          new AbortController().signal,
        );
        mcpServers.push({ id: server.id, label: server.id, tools });
        prompter.say(`  \`${server.id}\` offers ${String(tools.length)} tool(s).`);
      } catch (error) {
        // Offered without a list rather than blocking the folder: reconnecting
        // once it answers records what it says.
        mcpServers.push({ id: server.id, label: server.id });
        prompter.say(
          `  \`${server.id}\` did not answer, so it is offered without its tools: ` +
            (error instanceof Error ? error.message.slice(0, 140) : 'unknown error'),
        );
      }
    }

    const response = await fetch(new URL('/v1/host/connect', api), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        binding: {
          hostBindingId: id,
          label,
          root,
          writable,
          allowsExecution,
          mcpServers,
          ...(branchPrefix !== undefined ? { branchPrefix } : {}),
          // Only for a derived name. An explicit one is the operator's answer,
          // and renaming an answer would be theatre.
          ...(explicitId === undefined ? { namesInUse: namesInUseFor(policy.bindings) } : {}),
        },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `The workspace refused this (${String(response.status)}). ${detail.slice(0, 300)}`,
      );
    }
    const material = (await response.json()) as ConnectMaterial;
    // The name the workspace recorded, which may not be the one that was sent:
    // a machine that already offers this name to another workspace gets a unique
    // one back, chosen where the target space is known.
    const recorded = material.binding.hostBindingId;

    // An id is unique on this machine, while a workspace keys bindings by
    // (space, id). Connecting a same-named folder for a second workspace would
    // otherwise overwrite the first one's grant in this file — leaving its row
    // connected while nothing here answers for it — and every lookup, including
    // withdrawal, resolves by id alone and could not tell the two apart.
    //
    // Only an explicit `--id` can still land here: a derived name is sent with
    // the names this machine uses, and the workspace makes it unique. An
    // explicit one is an answer, so it is refused rather than rewritten — and
    // this is the one refusal that costs the code, because only redemption
    // reveals which workspace the folder was for.
    if (explicitId !== undefined) {
      const otherSpace = policy.bindings.find(
        (b) => b.id === recorded && b.spaceId !== undefined && b.spaceId !== material.spaceId,
      );
      if (otherSpace !== undefined) {
        throw new Error(
          `This machine already offers \`${recorded}\` to another workspace, and this machine ` +
            'keys bindings by id alone.\n' +
            `The workspace has recorded the folder, so disconnect \`${recorded}\` there and ` +
            'connect it again with `--id <name>`; that code is spent, so get another.',
        );
      }
    }

    // Accepted, so the machine's half is safe to commit. This order is
    // deliberate: an offered folder nothing has connected is not harmless — a
    // refused request would leave a grant on the machine the operator was told
    // had failed, against an id predictable enough to be claimed later.
    const binding: HostBinding = {
      id: recorded,
      root,
      mode: writable ? 'readwrite' : 'read',
      allowsExecution,
      ...(branchPrefix !== undefined ? { branchPolicy: { branchPrefix } } : {}),
      singleFile: info.isFile(),
      spaceId: material.spaceId,
    };
    policy.bindings = [...policy.bindings.filter((b) => b.id !== recorded), binding];
    await writePolicyAtomically(policyPath, serializePolicy(policy));

    // The credential arrives with the same call, so one command leaves the
    // machine able to do the work rather than merely permitted to.
    const envPath = resolve(HOST_DIR, 'host.env');
    const url = new URL(material.redisUrl);
    url.username = material.redisUsername;
    url.password = material.redisPassword;
    await writeFile(envPath, `REDIS_URL='${url.toString()}'\n`, { mode: 0o600 });
    await chmod(envPath, 0o600);

    reportDisagreement(prompter, policy.bindings, material, recorded);

    prompter.say(`Connected ${root} to ${material.spaceSlug} as \`${recorded}\`.`);
    if (recorded !== id) {
      prompter.say(
        `  Named \`${recorded}\` here, since \`${id}\` already reaches this folder for another ` +
          'workspace.',
      );
    }
    prompter.say(
      `  ${writable ? 'Readable and writable' : 'Read only'}${allowsExecution ? ', commands allowed' : ', no commands'}` +
        `${branchPrefix !== undefined ? `, pushes to branches under \`${branchPrefix}\`` : ', no pushes'}.`,
    );
    prompter.say('');
    // Asked rather than assumed. Telling an operator to start something already
    // running is worse than saying nothing: it reads as "not finished yet", and
    // the obedient response is to restart a service that was working.
    if (await executorIsRunning(url.toString())) {
      prompter.say('Ready to use.');
    } else {
      prompter.say('Ready once the executor is running on this machine:');
      prompter.say('  yarn executor:host');
    }
  } finally {
    prompter.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
