/**
 * Contract: the host grant admits the executor's traffic and nothing else.
 *
 * Pinned as text rather than as behaviour. A real-Redis run is what proved the
 * grant — the control stream, another lane's jobs, the session state hash,
 * `KEYS` and `FLUSHALL` are all refused under it — but that proof belongs to a
 * running server, and what this file protects is the decision: a command or key
 * family appearing here should be something someone chose.
 */
import { describe, expect, it } from 'vitest';

import {
  browserApprovalSpentKey,
  browserAskKey,
  browserHandoffKey,
  browserHandoffSpaceIndexKey,
} from '@aflow/redis';
import { ConsumerGroups, StreamKeys } from '@aflow/schemas';

import { renderRedisAcl } from './redisAcl.js';

const acl = renderRedisAcl({
  defaultPassword: 'd'.repeat(32),
  hostPassword: 'h'.repeat(32),
});
const hostLine = acl.split('\n').find((l) => l.startsWith('user hostexec')) ?? '';

describe('redis acl', () => {
  it('gives the appliance services a password where they previously had none', () => {
    // `resetpass` is part of the rule: SETUSER adds a password rather than
    // replacing one, so without it a rotation left the previous credential
    // valid and `/host/revoke` revoked nothing.
    expect(acl).toContain(`user default resetpass on >${'d'.repeat(32)} ~* &* +@all`);
  });

  it('grants the host executor only the key families it touches', () => {
    expect(hostLine).toContain('~aflow:jobs:host');
    expect(hostLine).toContain('~aflow:shard:*:results');
    expect(hostLine).toContain('~aflow:step:*:state');
    expect(hostLine).toContain('~aflow:executor-heartbeat:*');
    expect(hostLine).toContain('~aflow:executor-seen:*');
  });

  it('reads write-approval grants and cannot write one', () => {
    // A push its scan did not clear waits on the grant the operator's approval
    // minted; a credential that could write one could approve its own push.
    const patterns = hostLine.split(' ').filter((rule) => rule.includes('aflow:write-approval'));
    expect(patterns).toEqual(['%R~aflow:write-approval:*']);
  });

  it('writes the records beside a browser approval, which sit outside the grant family', () => {
    const askKeys = [
      browserAskKey('t', 'run-1', 'call'),
      browserApprovalSpentKey('t', 'run-1', { requestHash: 'h', decidedAt: 'now' }),
    ];
    const rules = hostLine.split(' ');
    expect(rules.filter((rule) => rule.includes('browser-ask'))).toEqual(['~aflow:browser-ask:*']);
    for (const key of askKeys) {
      expect(key.startsWith('aflow:browser-ask:')).toBe(true);
      expect(key.startsWith('aflow:write-approval:')).toBe(false);
    }
  });

  it('reaches no other lane, the control stream, or session state', () => {
    // Absence is the assertion: a pattern that would admit these is the bug.
    expect(hostLine).not.toContain('~*');
    expect(hostLine).not.toContain('aflow:control');
    expect(hostLine).not.toContain('aflow:session:');
  });

  it('subtracts the commands whose damage does not depend on a key', () => {
    // `+@all` is granted and then cut back, because the key patterns are what
    // bounds this identity. What has to go is the handful of commands that
    // ignore keys entirely.
    for (const command of [
      '-keys',
      '-scan',
      '-flushall',
      '-flushdb',
      '-config',
      '-acl',
      '-client',
      '-monitor',
      '-replicaof',
    ]) {
      expect(hostLine).toContain(command);
    }
  });

  it('admits every key a browser runtime touches, and no other lane', () => {
    // The host executor runs `browser.*` from a second runtime under this same
    // identity. Its consumer group is not a key — it lives in the stream — so
    // naming the stream is what admits the group.
    const patterns = hostLine
      .split(' ')
      .filter((rule) => rule.startsWith('~'))
      .map(
        (rule) =>
          new RegExp(
            `^${rule
              .slice(1)
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')}$`,
          ),
      );
    const admitted = (key: string): boolean => patterns.some((pattern) => pattern.test(key));

    const browserKeys = [
      StreamKeys.jobStream('browser'),
      'aflow:executor-heartbeat:browser:host-executor-4242',
      StreamKeys.shardResultsStream(0),
      StreamKeys.stepStateKey('t', 'step-1'),
      'aflow:step-inflight:step-1',
      'aflow:idempotency:step-1',
      'aflow:cancelled:t:step-1',
      'aflow:payload:tenants/t/runs/r/steps/step-1/attempt/1/output.json',
    ];
    expect(browserKeys.filter((key) => !admitted(key))).toEqual([]);
    expect(ConsumerGroups.executor('browser')).toBe('exec_browser');

    for (const lane of ['ai', 'api', 'search', 'compute', 'code']) {
      expect(admitted(StreamKeys.jobStream(lane))).toBe(false);
    }
  });

  it('admits a browser hand-off’s record and index, and the Done that ends its wait', () => {
    const rules = hostLine.split(' ');
    const admits = (prefix: '~' | '&', name: string): boolean =>
      rules
        .filter((rule) => rule.startsWith(prefix))
        .map(
          (rule) =>
            new RegExp(
              `^${rule
                .slice(1)
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')}$`,
            ),
        )
        .some((pattern) => pattern.test(name));

    expect(admits('~', browserHandoffKey('laptop', 'default', 'example.com'))).toBe(true);
    expect(admits('~', browserHandoffSpaceIndexKey('t', 'space-1'))).toBe(true);
    expect(admits('&', StreamKeys.browserHandoffDoneChannel('step-1'))).toBe(true);
    // The wake the executor sends when an item appears or goes.
    expect(admits('&', StreamKeys.actionCenterWakeChannel('t', 'space-1'))).toBe(true);
    expect(rules.filter((rule) => rule.includes('browser-handoff'))).toEqual([
      '~aflow:browser-handoff:*',
    ]);
    expect(rules.filter((rule) => rule.includes('handoff-done'))).toEqual([
      '&aflow:handoff-done:*',
    ]);
  });

  it('separates the two identities', () => {
    expect(hostLine).toContain('h'.repeat(32));
    expect(hostLine).not.toContain('d'.repeat(32));
  });
});
