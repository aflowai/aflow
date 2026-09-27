import { describe, expect, it } from 'vitest';
import type { IntegrationDescriptor } from '@aflow/schemas';
import { explainUnavailableIntegrationTool } from '../catalogToolPromote.js';
import type { IntegrationToolDiagnostic } from '../../../helpers/integrationReader.js';

const CRED_DIAG: IntegrationToolDiagnostic = {
  toolId: 'api:vercel-default/getAnalytics',
  cause: 'credential_missing',
  detail:
    'api binding "vercel-default" (vercel): expects credential key(s) "vercel-default-token" ' +
    'with no stored credential — the operator adds them in the Integrations page',
};

const BOUND_API_DESCRIPTOR = {
  sourceKind: 'api',
  integrationId: 'vercel',
  bindingId: 'vercel-default',
  name: 'Vercel',
  status: 'bound',
  toolCount: 9,
} as IntegrationDescriptor;

const BOUND_MCP_DESCRIPTOR = {
  sourceKind: 'mcp',
  integrationId: 'kaggle',
  bindingId: 'kaggle-default',
  name: 'Kaggle',
  status: 'bound',
  toolCount: 3,
} as IntegrationDescriptor;

const diagnostics = new Map([[CRED_DIAG.toolId, CRED_DIAG]]);
const descriptors = new Map([
  ['api:vercel-default', BOUND_API_DESCRIPTOR],
  ['mcp:kaggle-default', BOUND_MCP_DESCRIPTOR],
]);

describe('explainUnavailableIntegrationTool', () => {
  it('surfaces the diagnostic cause and detail for a known-but-not-ready tool', () => {
    const reason = explainUnavailableIntegrationTool(
      'api:vercel-default/getAnalytics',
      diagnostics,
      descriptors,
    );
    expect(reason.startsWith('credential_missing:')).toBe(true);
    expect(reason).toContain('"vercel-default-token"');
  });

  it('names the binding when no binding with that id exists', () => {
    const reason = explainUnavailableIntegrationTool(
      'api:nope-default/listThings',
      diagnostics,
      descriptors,
    );
    expect(reason.startsWith('unknown_binding:')).toBe(true);
    expect(reason).toContain('"nope-default"');
    expect(reason).toContain('api.binding.list');
  });

  it('names the endpoint when the binding is bound but the endpoint id is unknown', () => {
    const reason = explainUnavailableIntegrationTool(
      'api:vercel-default/getSpeedInsights',
      diagnostics,
      descriptors,
    );
    expect(reason.startsWith('unknown_endpoint:')).toBe(true);
    expect(reason).toContain('"getSpeedInsights"');
    expect(reason).toContain('api.definition.get');
  });

  it('flags a possibly-stale cache for an unknown MCP tool on a bound server', () => {
    const reason = explainUnavailableIntegrationTool(
      'mcp:kaggle-default/does_not_exist',
      diagnostics,
      descriptors,
    );
    expect(reason.startsWith('unknown_tool:')).toBe(true);
    expect(reason).toContain('stale');
  });
});

describe('explainUnavailableIntegrationTool — source-kind keying', () => {
  it('does not misattribute across an api/mcp bindingId collision', () => {
    const collidingDescriptors = new Map([['mcp:shared-default', BOUND_MCP_DESCRIPTOR]]);
    const reason = explainUnavailableIntegrationTool(
      'api:shared-default/listThings',
      new Map(),
      collidingDescriptors,
    );
    expect(reason.startsWith('unknown_binding:')).toBe(true);
    expect(reason).toContain('"shared-default"');
  });
});
