/**
 * `aflow browser`: the operator's commands for the agent's browser, on the
 * machine that holds it.
 *
 * Listing and signing in go through the running executor when there is one,
 * because the Chrome a profile's directory allows is the executor's; with none
 * running, this command starts the profile's browser itself through the same
 * driver, launch flags and egress proxy. Posture, `unattended`, origin rules
 * and the loopback ports a profile is opened to are edits to the policy file,
 * which a running executor follows as it follows any edit; the machine page's
 * edits go through the same writer, in the executor.
 */
import { readFile } from 'node:fs/promises';

import {
  BROWSER_LOCAL_PORTS_LINE,
  BROWSER_POSTURE_LINES,
  BROWSER_UNATTENDED_LINE,
  type BrowserOriginRule,
  BrowserPostureSchema,
  type BrowserProfile,
  DEFAULT_BROWSER_PROFILE_ID,
} from '@aflow/schemas';

import { HostPolicySchema, loadHostPolicy } from '../bindings.js';
import { editPolicy } from '../policyFile.js';
import { describePolicyIssues } from '../policyIssues.js';
import type { ChromeDiscovery } from './chromeDiscovery.js';
import { profileDirectory } from './chromeProcess.js';
import type { BrowserDriver } from './driver.js';
import { errorText } from './errors.js';
import { executorStackPorts, listedLocalPorts, type StackOwnPorts } from './localPorts.js';
import { SIGN_IN_SITTING_MAX_MS } from './operatorWindow.js';
import {
  declaredBrowsers,
  PolicyEditError,
  type RawPolicy,
  withLocalPort,
  withoutLocalPort,
  withoutRule,
  withPosture,
  withRule,
  withUnattended,
} from './policyEdit.js';
import { effectiveBrowserProfiles, parseBrowserProfiles } from './profiles.js';
import type { ProfileHolder } from './profileLock.js';
import { askExecutor, EXECUTOR_CLAIM_TIMEOUT_MS, type RequestClock } from './windowRequests.js';

export type BrowserCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'sign_in'; readonly profileId: string }
  | { readonly kind: 'posture'; readonly profileId: string; readonly posture: string }
  | { readonly kind: 'unattended'; readonly profileId: string; readonly choice: string }
  | {
      readonly kind: 'rule';
      readonly profileId: string;
      readonly origin: string;
      readonly effect: string;
    }
  | { readonly kind: 'rule_remove'; readonly profileId: string; readonly origin: string }
  | { readonly kind: 'local_port'; readonly profileId: string; readonly port: string }
  | { readonly kind: 'local_port_remove'; readonly profileId: string; readonly port: string };

const USAGE_INDENT = 44;
const USAGE_WIDTH = 92;

/** A usage entry, its explanation wrapped beside the synopsis. */
function usageEntry(synopsis: string, explanation: string): string {
  const lines: string[] = [];
  let line = '';
  for (const word of explanation.split(' ')) {
    if (line !== '' && USAGE_INDENT + line.length + 1 + word.length > USAGE_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  const pad = ' '.repeat(USAGE_INDENT);
  return lines
    .map((text, index) => (index === 0 ? `  ${synopsis}`.padEnd(USAGE_INDENT) : pad) + text)
    .join('\n');
}

export const BROWSER_USAGE = [
  'Usage:',
  usageEntry('browser list', 'The profiles, and what each one holds.'),
  usageEntry(
    'browser sign-in [profile]',
    'Open the profile’s browser in a window to sign in to what the agent should reach; close ' +
      'it when done. The `default` profile unless named.',
  ),
  usageEntry(
    'browser posture <profile> <posture>',
    BrowserPostureSchema.options
      .map((posture) => `${posture}: ${BROWSER_POSTURE_LINES[posture]}`)
      .join(' '),
  ),
  usageEntry('browser unattended <profile> allow|refuse', BROWSER_UNATTENDED_LINE),
  usageEntry(
    'browser rule <profile> <origin> <effect>',
    'allow, ask or deny pages at an origin, such as https://mail.example.com or *.example.com. ' +
      'ask: pages there open and are read, and every action on one waits for your approval.',
  ),
  usageEntry('browser rule <profile> <origin> --remove', 'Drop that rule.'),
  usageEntry('browser local-port <profile> <port>', BROWSER_LOCAL_PORTS_LINE),
  usageEntry('browser local-port <profile> <port> --remove', 'Close that port to it again.'),
].join('\n');

const RULE_GLOSS: Readonly<Record<BrowserOriginRule['effect'], string>> = {
  allow: '',
  deny: '',
  ask: ' — pages there open and are read; every action waits for your approval',
};

/** How long a list waits for the executor's answer once it has taken the request. */
const LIST_ANSWER_TIMEOUT_MS = 30_000;
/** Past the sitting's own limit: the executor restarts the browser on each side of it. */
const SIGN_IN_ANSWER_MARGIN_MS = 5 * 60_000;

/** The command the arguments name, or nothing when they name none. */
export function parseBrowserArgs(args: readonly string[]): BrowserCommand | undefined {
  const [command, ...rest] = args;
  if (command === undefined) return undefined;
  switch (command) {
    case 'list':
      return rest.length === 0 ? { kind: 'list' } : undefined;
    case 'sign-in': {
      const [profileId, extra] = rest;
      if (extra !== undefined || profileId?.startsWith('-') === true) return undefined;
      return { kind: 'sign_in', profileId: profileId ?? DEFAULT_BROWSER_PROFILE_ID };
    }
    case 'posture': {
      const [profileId, posture, extra] = rest;
      if (profileId === undefined || posture === undefined || extra !== undefined) return undefined;
      return { kind: 'posture', profileId, posture };
    }
    case 'unattended': {
      const [profileId, choice, extra] = rest;
      if (profileId === undefined || choice === undefined || extra !== undefined) return undefined;
      return { kind: 'unattended', profileId, choice };
    }
    case 'rule': {
      const removing = rest.includes('--remove');
      const words = rest.filter((word) => word !== '--remove');
      if (words.some((word) => word.startsWith('--'))) return undefined;
      const [profileId, origin, effect, extra] = words;
      if (profileId === undefined || origin === undefined || extra !== undefined) return undefined;
      if (removing) {
        return effect === undefined ? { kind: 'rule_remove', profileId, origin } : undefined;
      }
      return effect === undefined ? undefined : { kind: 'rule', profileId, origin, effect };
    }
    case 'local-port': {
      const removing = rest.includes('--remove');
      const words = rest.filter((word) => word !== '--remove');
      if (words.some((word) => word.startsWith('--'))) return undefined;
      const [profileId, port, extra] = words;
      if (profileId === undefined || port === undefined || extra !== undefined) return undefined;
      return removing
        ? { kind: 'local_port_remove', profileId, port }
        : { kind: 'local_port', profileId, port };
    }
    default:
      return undefined;
  }
}

export interface BrowserCliDeps {
  readonly hostDir: string;
  readonly policyPath: string;
  readonly print: (line: string) => void;
  readonly findChrome: () => ChromeDiscovery;
  readonly clock: RequestClock;
  /** A driver of this command's own, for when no executor is running. */
  readonly ownDriver: () => Promise<BrowserDriver>;
  /** The live Chrome holding a profile's directory, if one does. */
  readonly profileHolder: (profileId: string) => Promise<ProfileHolder | undefined>;
  /** Tests fix it; otherwise the ports this command's environment and the defaults name. */
  readonly stackPorts?: StackOwnPorts;
}

export class BrowserCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserCliError';
  }
}

async function readPolicy(policyPath: string): Promise<RawPolicy> {
  const raw = await readFile(policyPath, 'utf8').catch(() => undefined);
  return validPolicy(policyPath, raw === undefined ? undefined : (JSON.parse(raw) as unknown));
}

/** The policy file's JSON as it stands, refused when it is missing or not a valid policy. */
function validPolicy(policyPath: string, json: unknown): RawPolicy {
  if (json === undefined) {
    throw new BrowserCliError(`No host policy at ${policyPath}. Pair this machine first.`);
  }
  const parsed = HostPolicySchema.safeParse(json);
  if (!parsed.success) {
    throw new BrowserCliError(
      `The host policy at ${policyPath} is not valid, so it was not changed: ` +
        describePolicyIssues(parsed.error),
    );
  }
  return json as RawPolicy;
}

/** A change to one profile's posture, `unattended` choice, origin rules or local ports. */
export type BrowserSettingCommand = Extract<
  BrowserCommand,
  { kind: 'posture' | 'unattended' | 'rule' | 'rule_remove' | 'local_port' | 'local_port_remove' }
>;

function settingEdit(
  command: BrowserSettingCommand,
  stackOwn: StackOwnPorts,
): (policy: RawPolicy, implied: readonly BrowserProfile[]) => RawPolicy {
  switch (command.kind) {
    case 'posture':
      return (policy, implied) => withPosture(policy, implied, command.profileId, command.posture);
    case 'unattended':
      return (policy, implied) =>
        withUnattended(policy, implied, command.profileId, command.choice);
    case 'rule':
      return (policy, implied) =>
        withRule(policy, implied, command.profileId, command.origin, command.effect);
    case 'rule_remove':
      return (policy, implied) => withoutRule(policy, implied, command.profileId, command.origin);
    case 'local_port':
      return (policy, implied) =>
        withLocalPort(policy, implied, command.profileId, command.port, stackOwn);
    case 'local_port_remove':
      return (policy, implied) =>
        withoutLocalPort(policy, implied, command.profileId, command.port);
  }
}

export interface BrowserSettingChanged {
  /** The profile as the policy file now declares it. */
  readonly profile: BrowserProfile;
  /** The implied profiles written out before the change, when the file declared none. */
  readonly impliedWrittenOut?: readonly string[];
}

/**
 * The one writer of a profile's settings, for `aflow browser` and for the
 * operator's request from the machine page alike, so the two validate and
 * write the same way. Holds the policy file's lock from reading it to writing
 * it, so a change made meanwhile by the other is never written over. A
 * running executor follows the file as it follows any edit.
 */
export async function changeBrowserSetting(
  policyPath: string,
  findChrome: () => ChromeDiscovery,
  command: BrowserSettingCommand,
  stackOwn: StackOwnPorts,
): Promise<BrowserSettingChanged> {
  let impliedWrittenOut: string[] | undefined;
  const next = await editPolicy(policyPath, (current) => {
    const policy = validPolicy(policyPath, current);
    const implied = [...effectiveBrowserProfiles(undefined, findChrome()).values()];
    if (policy.browsers === undefined) {
      impliedWrittenOut = declaredBrowsers(policy, implied).map((entry) =>
        String((entry as { id?: unknown }).id),
      );
    }
    try {
      return settingEdit(command, stackOwn)(policy, implied);
    } catch (error) {
      if (error instanceof PolicyEditError) throw new BrowserCliError(error.message);
      throw error;
    }
  });
  const profile = parseBrowserProfiles(next.browsers ?? []).profiles.find(
    (declared) => declared.id === command.profileId,
  );
  if (profile === undefined) {
    throw new BrowserCliError(
      `Profile \`${command.profileId}\` was written but does not read back as valid; ` +
        'the policy file says why.',
    );
  }
  return { profile, ...(impliedWrittenOut !== undefined ? { impliedWrittenOut } : {}) };
}

async function edit(
  deps: BrowserCliDeps,
  command: BrowserSettingCommand,
  said: string,
): Promise<void> {
  const changed = await changeBrowserSetting(
    deps.policyPath,
    deps.findChrome,
    command,
    deps.stackPorts ?? executorStackPorts(),
  );
  if (changed.impliedWrittenOut !== undefined) {
    deps.print(
      'This machine’s policy declared no browser profiles, so the implied one was written out ' +
        `before the change: ${changed.impliedWrittenOut.join(', ')}.`,
    );
  }
  deps.print(said);
  deps.print('A running browser executor follows the change at once.');
}

function sitesLine(sites: readonly string[]): string {
  return sites.length > 0
    ? `Sites that hold a session: ${sites.join(', ')}.`
    : 'No site holds a session in it.';
}

async function list(deps: BrowserCliDeps): Promise<void> {
  const stackOwn = deps.stackPorts ?? executorStackPorts();
  const raw = await readPolicy(deps.policyPath);
  const policy = await loadHostPolicy(deps.policyPath, deps.findChrome);
  const asked = await askExecutor(
    deps.hostDir,
    { kind: 'list' },
    { clock: deps.clock, resultTimeoutMs: LIST_ANSWER_TIMEOUT_MS },
  );
  if (asked.answeredBy === 'executor' && asked.result.kind === 'refused') {
    throw new BrowserCliError(asked.result.message);
  }
  const running = new Map(
    asked.answeredBy === 'executor' && asked.result.kind === 'list'
      ? asked.result.profiles.map((profile) => [profile.id, profile])
      : [],
  );
  if (policy.browsers.size === 0) {
    deps.print(
      policy.chrome.found === undefined
        ? 'No browser profile: no supported Chrome was found. Looked in: ' +
            `${policy.chrome.searched.join(', ')}.`
        : 'No browser profile is declared on this machine.',
    );
  } else if (raw.browsers === undefined) {
    deps.print('This machine’s policy declares no profiles, so it offers the implied one:');
  }
  for (const profile of policy.browsers.values()) {
    const spaces = profile.spaces === 'all' ? 'every space' : `spaces ${profile.spaces.join(', ')}`;
    const unattended = profile.unattended
      ? 'and to runs nobody is present for'
      : 'closed to runs nobody is present for';
    deps.print(
      `${profile.id} — ${profile.posture}, window ${profile.window}, idle after ` +
        `${String(profile.idleMinutes)} minutes, open to ${spaces}, ${unattended}`,
    );
    if (profile.posture === 'ask-to-act') {
      deps.print('    every action waits for your approval in the Action Center');
    }
    for (const rule of profile.rules) {
      deps.print(`    ${rule.effect} ${rule.origin}${RULE_GLOSS[rule.effect]}`);
    }
    for (const { port, refused } of listedLocalPorts(profile, stackOwn)) {
      deps.print(
        refused === undefined
          ? `    loads port ${String(port)} on loopback`
          : `    port ${String(port)} is listed and refused: ${refused}`,
      );
    }
    deps.print(`    directory: ${profileDirectory(deps.hostDir, profile.id)}`);
    const now = running.get(profile.id);
    deps.print(
      now?.running === true ? `    running. ${sitesLine(now.sites ?? [])}` : '    stopped',
    );
  }
  for (const [id, reason] of policy.invalidBrowsers) {
    deps.print(`${id} — disabled, not valid: ${reason}`);
  }
  if (asked.answeredBy === 'nobody') {
    deps.print('\nNo browser executor is running on this machine, so no profile’s browser is.');
  }
}

function heldMessage(profileId: string, holder: ProfileHolder): string {
  const by =
    holder.startedBy === undefined
      ? `Chrome, process ${String(holder.chromePid)}`
      : `process ${String(holder.startedBy.pid)} (${holder.startedBy.command}), through its ` +
        `Chrome, process ${String(holder.chromePid)}`;
  return (
    `Profile \`${profileId}\` is in use by ${by}, and only one browser can use a profile at a ` +
    'time. A browser executor holding it did not take this request within ' +
    `${String(EXECUTOR_CLAIM_TIMEOUT_MS / 1000)} seconds; its log says why. Nothing was opened.`
  );
}

async function signIn(deps: BrowserCliDeps, profileId: string): Promise<void> {
  const instructions =
    'Sign in to every site the agent should reach, in as many tabs as you like, then close the ' +
    'window.';
  const asked = await askExecutor(
    deps.hostDir,
    { kind: 'sign_in', profileId },
    {
      clock: deps.clock,
      resultTimeoutMs: SIGN_IN_SITTING_MAX_MS + SIGN_IN_ANSWER_MARGIN_MS,
      onClaimed: () => {
        deps.print(
          `The browser executor is opening a window for profile \`${profileId}\`. ` +
            `${instructions} Runs using the profile are refused until you do.`,
        );
      },
    },
  );
  if (asked.answeredBy === 'executor') {
    const result = asked.result;
    if (result.kind === 'refused') throw new BrowserCliError(result.message);
    if (result.kind !== 'sign_in') {
      throw new BrowserCliError('The browser executor answered a different question.');
    }
    if (result.outcome === 'timed_out') {
      deps.print('The window was open for an hour and has been closed; runs may use it again.');
    }
    deps.print(sitesLine(result.sites));
    return;
  }
  const holder = await deps.profileHolder(profileId);
  if (holder !== undefined) throw new BrowserCliError(heldMessage(profileId, holder));
  deps.print(
    'No browser executor is running on this machine, so this command opens profile ' +
      `\`${profileId}\` itself. ${instructions}`,
  );
  const driver = await deps.ownDriver();
  try {
    deps.print(sitesLine((await driver.signIn(profileId)).sites));
  } catch (error) {
    throw new BrowserCliError(errorText(error));
  } finally {
    await driver.stopAll();
  }
}

export async function runBrowserCommand(
  command: BrowserCommand,
  deps: BrowserCliDeps,
): Promise<void> {
  switch (command.kind) {
    case 'list':
      await list(deps);
      return;
    case 'sign_in':
      await signIn(deps, command.profileId);
      return;
    case 'posture':
      await edit(deps, command, `Profile \`${command.profileId}\` is now ${command.posture}.`);
      return;
    case 'unattended':
      await edit(
        deps,
        command,
        command.choice === 'allow'
          ? `Profile \`${command.profileId}\` is open to runs nobody is present for.`
          : `Profile \`${command.profileId}\` is closed to runs nobody is present for: only a ` +
              'run a person’s request last set going, or a run attended at that moment did, ' +
              'may use it.',
      );
      return;
    case 'rule':
      await edit(
        deps,
        command,
        `Profile \`${command.profileId}\`: ${command.effect} ${command.origin}.`,
      );
      return;
    case 'rule_remove':
      await edit(
        deps,
        command,
        `Profile \`${command.profileId}\` no longer has a rule for ${command.origin}.`,
      );
      return;
    case 'local_port':
      await edit(
        deps,
        command,
        `Profile \`${command.profileId}\` loads port ${command.port.trim()} on loopback — ` +
          'localhost, 127.0.0.1, [::1] — and on no other address of this machine.',
      );
      return;
    case 'local_port_remove':
      await edit(
        deps,
        command,
        `Profile \`${command.profileId}\` no longer loads port ${command.port.trim()}.`,
      );
      return;
  }
}
