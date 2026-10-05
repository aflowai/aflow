/**
 * The operator's edits to the browser profiles in the policy file.
 *
 * Profiles are edited as the file holds them, so a field the operator wrote by
 * hand — or left to its default — stays as it was. A file with no `browsers`
 * field implies the `default` profile; the first edit writes that profile out
 * before changing it, because declaring any profile replaces the implied one,
 * and an edit that silently took the default away would leave the machine with
 * no browser.
 */
import { describeStackPortOwner } from '@aflow/lib';
import {
  type BrowserOriginRule,
  BrowserOriginRuleSchema,
  BrowserPostureSchema,
  type BrowserProfile,
  browserStackPortRefusal,
  parseBrowserOriginPattern,
} from '@aflow/schemas';

import { parseLocalPorts } from '../browserLocalPorts.js';
import { describePolicyIssues } from '../policyIssues.js';
import type { StackOwnPorts } from './localPorts.js';
import { parseBrowserProfiles } from './profiles.js';

/** The policy file as JSON, with the one field these edits touch. */
export interface RawPolicy {
  [field: string]: unknown;
  browsers?: unknown[];
}

export class PolicyEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyEditError';
  }
}

type Entry = Record<string, unknown>;

function asEntry(value: unknown): Entry {
  return typeof value === 'object' && value !== null ? (value as Entry) : {};
}

/** The profiles as declared, or the implied ones written out by their ids. */
export function declaredBrowsers(policy: RawPolicy, implied: readonly BrowserProfile[]): unknown[] {
  return policy.browsers ?? implied.map((profile) => ({ id: profile.id }));
}

function editProfile(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  edit: (entry: Entry) => Entry,
): RawPolicy {
  const browsers = declaredBrowsers(policy, implied);
  const index = browsers.findIndex((entry) => asEntry(entry)['id'] === profileId);
  if (index < 0) {
    const ids = browsers.map((entry) => String(asEntry(entry)['id']));
    throw new PolicyEditError(
      `This machine has no browser profile '${profileId}'. Profiles here: ` +
        `${ids.length > 0 ? ids.join(', ') : 'none'}.`,
    );
  }
  const edited = edit({ ...asEntry(browsers[index]) });
  const problem = parseBrowserProfiles([edited]).invalid.get(profileId);
  if (problem !== undefined) {
    throw new PolicyEditError(`'${profileId}' would not be valid after that change: ${problem}`);
  }
  const next = [...browsers];
  next[index] = edited;
  return { ...policy, browsers: next };
}

export function withPosture(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  requested: string,
): RawPolicy {
  const posture = BrowserPostureSchema.safeParse(requested);
  if (!posture.success) {
    throw new PolicyEditError(
      `'${requested}' is not a posture. Choose one of ${BrowserPostureSchema.options.join(', ')}.`,
    );
  }
  return editProfile(policy, implied, profileId, (entry) => ({ ...entry, posture: posture.data }));
}

/** `allow` or `refuse`, as `aflow browser unattended` takes it, into the profile's `unattended`. */
export function withUnattended(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  requested: string,
): RawPolicy {
  const unattended = requested === 'allow' ? true : requested === 'refuse' ? false : undefined;
  if (unattended === undefined) {
    throw new PolicyEditError(
      `'${requested}' says nothing about runs nobody is present for. Choose allow or refuse.`,
    );
  }
  return editProfile(policy, implied, profileId, (entry) => ({ ...entry, unattended }));
}

function rulesOf(entry: Entry): BrowserOriginRule[] {
  return Array.isArray(entry['rules']) ? (entry['rules'] as BrowserOriginRule[]) : [];
}

/** Adds the rule, or replaces the effect of the one already naming the same origin. */
export function withRule(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  origin: string,
  effect: string,
): RawPolicy {
  const rule = BrowserOriginRuleSchema.safeParse({ origin, effect });
  if (!rule.success) throw new PolicyEditError(describePolicyIssues(rule.error));
  return editProfile(policy, implied, profileId, (entry) => ({
    ...entry,
    rules: [...rulesOf(entry).filter((existing) => existing.origin !== origin), rule.data],
  }));
}

export function withoutRule(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  origin: string,
): RawPolicy {
  if (parseBrowserOriginPattern(origin) === undefined) {
    throw new PolicyEditError(`'${origin}' is not an origin rule's pattern, so no rule names it.`);
  }
  return editProfile(policy, implied, profileId, (entry) => {
    const rules = rulesOf(entry);
    if (!rules.some((existing) => existing.origin === origin)) {
      const held = rules.map((existing) => `${existing.effect} ${existing.origin}`);
      throw new PolicyEditError(
        `'${profileId}' has no rule for '${origin}'. Its rules: ` +
          `${held.length > 0 ? held.join(', ') : 'none'}.`,
      );
    }
    return { ...entry, rules: rules.filter((existing) => existing.origin !== origin) };
  });
}

/** A port as `aflow browser local-port` takes it, as `aflow harness browser-ports` takes one. */
function parsePort(requested: string): number {
  const parsed = parseLocalPorts([requested.trim()]);
  if (!parsed.ok || parsed.ports[0] === undefined) {
    throw new PolicyEditError(`'${requested}' is not a port: give a whole number from 1 to 65535.`);
  }
  return parsed.ports[0];
}

function localPortsOf(entry: Entry): number[] {
  return Array.isArray(entry['localPorts']) ? (entry['localPorts'] as number[]) : [];
}

/**
 * Opens a loopback port to the profile, refused when this stack serves on it:
 * the egress proxy would refuse it at every connection anyway, and the
 * operator is owed the reason now rather than a page that never loads.
 */
export function withLocalPort(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  requested: string,
  stackOwn: StackOwnPorts,
): RawPolicy {
  const port = parsePort(requested);
  const owner = stackOwn.get(port);
  if (owner !== undefined) {
    throw new PolicyEditError(browserStackPortRefusal(port, describeStackPortOwner(owner)));
  }
  return editProfile(policy, implied, profileId, (entry) => {
    const ports = localPortsOf(entry);
    return {
      ...entry,
      localPorts: ports.includes(port) ? ports : [...ports, port].sort((a, b) => a - b),
    };
  });
}

export function withoutLocalPort(
  policy: RawPolicy,
  implied: readonly BrowserProfile[],
  profileId: string,
  requested: string,
): RawPolicy {
  const port = parsePort(requested);
  return editProfile(policy, implied, profileId, (entry) => {
    const ports = localPortsOf(entry);
    if (!ports.includes(port)) {
      throw new PolicyEditError(
        `'${profileId}' is not opened to port ${String(port)}. Its local ports: ` +
          `${ports.length > 0 ? ports.join(', ') : 'none'}.`,
      );
    }
    return { ...entry, localPorts: ports.filter((held) => held !== port) };
  });
}
