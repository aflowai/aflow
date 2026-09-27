import { describe, it, expect } from 'vitest';
import type { CredentialSlot } from '@aflow/schemas';
import { deriveMcpBindingSetupTask } from './bundleInstallManifest.js';

const tokenSlot: CredentialSlot = {
  authField: 'credentialKey',
  credentialKey: 'kaggle-default-token',
  role: 'token',
  label: 'API token',
};

function bearerInput(over: Partial<Parameters<typeof deriveMcpBindingSetupTask>[0]> = {}) {
  return {
    bindingId: 'kaggle-default',
    serverId: 'kaggle',
    name: 'Kaggle MCP',
    authType: 'bearer' as const,
    credentialSlots: [tokenSlot],
    authJson: { type: 'bearer', credentialKey: 'kaggle-default-token' },
    pinnedOrigin: null,
    enabled: false,
    presentCredentialKeys: new Set<string>(),
    ...over,
  };
}

describe('deriveMcpBindingSetupTask', () => {
  it('emits fill_mcp_credentials while a slot key is unfilled', () => {
    const task = deriveMcpBindingSetupTask(bearerInput());
    expect(task).toEqual({
      kind: 'fill_mcp_credentials',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      slots: [tokenSlot],
      description: 'Add credentials for the Kaggle MCP integration.',
      required: true,
    });
  });

  it('prefers the installed auth_json key over the declared slot key', () => {
    // The operator rewired the binding to a different credential key; presence
    // of THAT key means the slot is filled even though the declared key is not.
    const task = deriveMcpBindingSetupTask(
      bearerInput({
        authJson: { type: 'bearer', credentialKey: 'operator-key' },
        presentCredentialKeys: new Set(['operator-key']),
      }),
    );
    expect(task?.kind).toBe('run_mcp_binding_test');
  });

  it('emits run_mcp_binding_test once credentials are filled but no origin is pinned', () => {
    const task = deriveMcpBindingSetupTask(
      bearerInput({ presentCredentialKeys: new Set(['kaggle-default-token']) }),
    );
    expect(task).toEqual({
      kind: 'run_mcp_binding_test',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      description: 'Open the Kaggle MCP integration and save to verify the connection.',
      required: true,
    });
  });

  it('returns null for a credentialed binding that is filled and pinned', () => {
    const task = deriveMcpBindingSetupTask(
      bearerInput({
        presentCredentialKeys: new Set(['kaggle-default-token']),
        pinnedOrigin: 'https://mcp.kaggle.com',
      }),
    );
    expect(task).toBeNull();
  });

  it('emits run_mcp_binding_test for a disabled public server (auth none)', () => {
    const task = deriveMcpBindingSetupTask(
      bearerInput({
        authType: 'none',
        credentialSlots: [],
        authJson: { type: 'none' },
      }),
    );
    expect(task).toEqual({
      kind: 'run_mcp_binding_test',
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      description: 'Open the Kaggle MCP integration and save to connect and enable.',
      required: true,
    });
  });

  it('returns null for an enabled public server', () => {
    const task = deriveMcpBindingSetupTask(
      bearerInput({
        authType: 'none',
        credentialSlots: [],
        authJson: { type: 'none' },
        enabled: true,
      }),
    );
    expect(task).toBeNull();
  });

  it('uses the template description on the fill task when present', () => {
    const task = deriveMcpBindingSetupTask(bearerInput({ description: 'Paste the Kaggle PAT.' }));
    expect(task?.kind).toBe('fill_mcp_credentials');
    expect(task?.description).toBe('Paste the Kaggle PAT.');
  });
});
