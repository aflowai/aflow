/**
 * Plan 336 §5, the UI case: a test whose wait response carries a refused
 * connect names the range in words and offers the remedy as an action.
 */
import { describe, expect, it } from 'vitest';
import {
  SET_PRIVATE_NETWORK_LABEL,
  describeMcpRefusal,
  parseHostList,
  proposedPrivateNetworkHosts,
  testResultFromWaitBody,
} from './mcpEgressRefusal.js';

const PRIVATE_RANGE = 'private network address (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16)';

function failed(details: unknown) {
  return testResultFromWaitBody({
    status: 'FAILED',
    error: { code: 'VALIDATION_ERROR', message: 'Blocked', details },
  });
}

describe('a test refused on a private address', () => {
  const result = failed({
    kind: 'private-ip',
    target: 'mcp.corp.example',
    rangeLabel: 'private-rfc1918',
    range: PRIVATE_RANGE,
    remedy: 'acknowledge_private_network',
  });

  it('carries the refusal from the step error details', () => {
    expect(result).toMatchObject({
      ok: false,
      message: 'Blocked',
      errorCode: 'VALIDATION_ERROR',
      refusal: { kind: 'private-ip', remedy: 'acknowledge_private_network' },
    });
  });

  it('names the range in words and offers Set as private network', () => {
    const view = describeMcpRefusal(result.refusal!);
    expect(view?.text).toContain(`mcp.corp.example is on a ${PRIVATE_RANGE}.`);
    expect(view?.action).toBe('set_private_network');
    expect(SET_PRIVATE_NETWORK_LABEL).toBe('Set as private network');
  });
});

describe('the other remedies', () => {
  it('names the deployment variable for a host the hosted deployment does not list', () => {
    const view = describeMcpRefusal(
      failed({
        kind: 'private-ip',
        target: '10.1.2.3',
        range: PRIVATE_RANGE,
        remedy: 'deployment_must_list_host',
      }).refusal!,
    );
    expect(view?.text).toContain('MCP_PRIVATE_NETWORK_HOSTS');
    expect(view?.action).toBeNull();
  });

  it('says no setting reaches a range the acknowledgment never lifts', () => {
    const view = describeMcpRefusal(
      failed({
        kind: 'private-ip',
        target: 'metadata.google.internal',
        range: 'cloud metadata address (169.254.169.254)',
        remedy: 'none',
      }).refusal!,
    );
    expect(view).toEqual({
      text: 'metadata.google.internal is on a cloud metadata address (169.254.169.254). No setting reaches it.',
      action: null,
    });
  });

  it('names the https rule', () => {
    const view = describeMcpRefusal(
      failed({ kind: 'invalid-protocol', target: 'mcp.corp.example', remedy: 'none' }).refusal!,
    );
    expect(view?.text).toContain('https only');
    expect(view?.action).toBeNull();
  });

  it('says the name does not resolve from this machine', () => {
    const view = describeMcpRefusal(
      failed({ kind: 'unresolvable', target: 'mcp.corp.example' }).refusal!,
    );
    expect(view?.text).toBe(
      'This machine cannot resolve mcp.corp.example. The VPN or its DNS may not reach the service from here.',
    );
  });

  it('leaves the tenant allowlist refusal to its own message', () => {
    expect(describeMcpRefusal({ kind: 'allowlist-host', target: 'x.example' })).toBeNull();
  });
});

describe('a failure that is not a refusal', () => {
  it('keeps the message and carries no refusal', () => {
    const result = failed({ provider: 'mcp' });
    expect(result.refusal).toBeUndefined();
    expect(result.message).toBe('Blocked');
  });

  it('reads a success as ok', () => {
    expect(testResultFromWaitBody({ status: 'SUCCEEDED' })).toEqual({ ok: true });
  });
});

describe('the hosts the form starts from', () => {
  it('starts from the server URL host and the refused host when nothing is set', () => {
    expect(
      proposedPrivateNetworkHosts([], 'auth.corp.example', 'https://MCP.corp.example./mcp'),
    ).toEqual(['auth.corp.example', 'mcp.corp.example']);
  });

  it('keeps the stored hosts and adds the refused one once', () => {
    expect(
      proposedPrivateNetworkHosts(
        ['mcp.corp.example'],
        'mcp.corp.example',
        'https://mcp.corp.example/mcp',
      ),
    ).toEqual(['mcp.corp.example']);
  });

  it('reads one host per line or comma', () => {
    expect(parseHostList(' a.example\n\nb.example, c.example ')).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ]);
  });
});
