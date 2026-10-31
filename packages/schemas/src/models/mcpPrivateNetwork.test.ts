import { describe, expect, it } from 'vitest';
import {
  MCP_PRIVATE_NETWORK_HOSTS_ENV,
  McpPrivateNetworkAcknowledgmentSchema,
  mcpPrivateNetworkDeploymentHosts,
  parseMcpPrivateNetworkAcknowledgment,
  privateNetworkHostProblem,
} from './mcpPrivateNetwork.js';
import { McpServerDefinitionSchema } from './mcpServerDefinition.js';
import { McpServerUpsertInputSchema } from '../operations/mcp/server.js';
import { BundledMcpServerDefinitionSchema } from '../cybernetic/skillBundle.js';
import { isLocalEdition } from '../edition/descriptor.js';

const RECORD = {
  hosts: ['mcp.corp.example'],
  setBy: '00000000-0000-4000-8000-0000000000aa',
  setAt: '2026-10-30T12:00:00.000Z',
};

describe('privateNetworkHostProblem', () => {
  it('accepts an exact hostname, a .internal name and a canonical quad', () => {
    for (const host of ['mcp.corp.example', 'MCP.Corp.Internal.', '10.0.0.5', '100.64.1.2']) {
      expect(privateNetworkHostProblem(host), host).toBeNull();
    }
  });

  it('refuses a wildcard, a URL, a port and a non-canonical number', () => {
    expect(privateNetworkHostProblem('*.corp.example')).toMatch(/wildcard/);
    expect(privateNetworkHostProblem('https://mcp.corp.example/')).toMatch(/bare host/);
    expect(privateNetworkHostProblem('mcp.corp.example:8443')).toMatch(/bare host/);
    expect(privateNetworkHostProblem('010.0.0.1')).toMatch(/dotted quad/);
    expect(privateNetworkHostProblem('167772161')).toMatch(/dotted quad/);
  });

  it('refuses what no answer could make reachable', () => {
    for (const host of [
      'localhost',
      'metadata',
      '127.0.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '::1',
    ]) {
      expect(privateNetworkHostProblem(host), host).toMatch(/no setting reaches/);
    }
  });
});

describe('the record is not on the definition', () => {
  it('has no field in any agent-writable or bundled definition schema', () => {
    for (const shape of [
      McpServerDefinitionSchema.shape,
      McpServerUpsertInputSchema.shape,
      BundledMcpServerDefinitionSchema.shape.definition.shape,
    ]) {
      expect(Object.keys(shape)).not.toContain('privateNetwork');
    }
  });

  it('is stripped from a definition or an upsert input that carries it', () => {
    const definition = {
      serverId: 'corp',
      name: 'Corp',
      serverUrl: 'https://mcp.corp.example/mcp',
      privateNetwork: RECORD,
    };
    expect(McpServerDefinitionSchema.parse(definition)).not.toHaveProperty('privateNetwork');
    expect(McpServerUpsertInputSchema.parse(definition)).not.toHaveProperty('privateNetwork');
  });
});

describe('the stored record', () => {
  it('parses a record and reads anything else as none', () => {
    expect(parseMcpPrivateNetworkAcknowledgment(RECORD)).toEqual(RECORD);
    expect(parseMcpPrivateNetworkAcknowledgment(null)).toBeNull();
    expect(parseMcpPrivateNetworkAcknowledgment({ hosts: [] })).toBeNull();
    expect(McpPrivateNetworkAcknowledgmentSchema.safeParse({ ...RECORD, hosts: [] }).success).toBe(
      false,
    );
  });
});

describe('mcpPrivateNetworkDeploymentHosts', () => {
  it('reads comma-separated hosts, normalized and deduplicated', () => {
    expect(
      mcpPrivateNetworkDeploymentHosts({
        [MCP_PRIVATE_NETWORK_HOSTS_ENV]: ' MCP.corp.example , auth.corp.example.,,mcp.corp.example',
      }),
    ).toEqual(['mcp.corp.example', 'auth.corp.example']);
    expect(mcpPrivateNetworkDeploymentHosts({})).toEqual([]);
  });
});

describe('isLocalEdition', () => {
  it('answers from the descriptor', () => {
    expect(isLocalEdition({ edition: 'community-local' })).toBe(true);
    expect(isLocalEdition({ edition: 'enterprise' })).toBe(false);
  });
});
