import { describe, it, expect } from 'vitest';
import {
  ApiDefinitionSchema,
  ConnectorCatalogEntrySchema,
  normalizeBindingInput,
} from '@aflow/schemas';
import { bundledApiDefinitionFromConnector } from '../skillBundleCatalog/connectorApiDefinitions.js';
import { GITHUB_API_DEFINITION } from '../skillBundleCatalog/githubApiDefinitions.js';
import { GITHUB_CONNECTOR } from './github.js';
import { getConnectorCatalogEntry, listConnectorCatalog } from './index.js';

describe('GitHub connector catalog entry', () => {
  it('parses cleanly through ConnectorCatalogEntrySchema', () => {
    const result = ConnectorCatalogEntrySchema.safeParse(GITHUB_CONNECTOR);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('embeds a definition that passes ApiDefinitionSchema', () => {
    const result = ApiDefinitionSchema.safeParse(GITHUB_CONNECTOR.definition);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true,
    );
  });

  it('uses a fixed baseUrl with no template or variables', () => {
    expect(GITHUB_CONNECTOR.definition.baseUrl).toBe('https://api.github.com');
    expect(GITHUB_CONNECTOR.definition.baseUrlTemplate).toBeUndefined();
    expect(GITHUB_CONNECTOR.definition.variables).toBeUndefined();
  });

  it('declares a body schema for every body-bearing endpoint', () => {
    for (const ep of GITHUB_CONNECTOR.definition.endpoints) {
      for (const param of ep.params) {
        if (param.location === 'body') {
          expect(param.schema, `endpoint ${ep.endpointId} body schema`).toBeDefined();
        }
      }
    }
  });

  it('is registered in the connector catalog', () => {
    expect(getConnectorCatalogEntry('github')).toEqual(GITHUB_CONNECTOR);
    expect(listConnectorCatalog().map((e) => e.catalogId)).toContain('github');
  });

  it('declares the PR-lifecycle endpoints', () => {
    const endpointIds = GITHUB_CONNECTOR.definition.endpoints.map((e) => e.endpointId);
    expect(endpointIds).toContain('createPullRequest');
    expect(endpointIds).toContain('listPullRequestFiles');
    expect(endpointIds).toContain('listCheckRuns');
    expect(endpointIds).toContain('mergePullRequest');
    expect(endpointIds).toContain('closePullRequest');
  });
});

/**
 * A binding sends its token to every host in its allowedHosts on a direct-URL
 * call, so every host a GitHub binding is created with can receive the token.
 * The only such host is GitHub's API: the storage hosts a job's log is served
 * from are `getJobLogs`' redirect hosts, followed without the token, and never
 * the binding's.
 */
describe("a GitHub binding's hosts", () => {
  const LOG_HOSTS = ['*.blob.core.windows.net', '*.actions.githubusercontent.com'];

  it('are api.github.com alone when created from the connector’s suggested egress', () => {
    const { egressPolicy } = normalizeBindingInput({
      rawAuth: { type: 'bearer', credentialKey: 'github-token' },
      definitionBaseUrl: GITHUB_CONNECTOR.definition.baseUrl,
      ...(GITHUB_CONNECTOR.definition.suggestedEgressPolicy !== undefined
        ? { suggestedEgressPolicy: GITHUB_CONNECTOR.definition.suggestedEgressPolicy }
        : {}),
    });
    expect(egressPolicy.allowedHosts).toEqual(['api.github.com']);
    for (const host of LOG_HOSTS) expect(egressPolicy.allowedHosts).not.toContain(host);
  });

  it('gain no host from the definitions a bundle installs', () => {
    for (const definition of [
      GITHUB_API_DEFINITION.definition,
      bundledApiDefinitionFromConnector(GITHUB_CONNECTOR).definition,
    ]) {
      expect(definition.suggestedEgressPolicy?.additionalHosts).toBeUndefined();
      expect(definition.suggestedEgressPolicy?.allowCrossHostRedirects).toBeUndefined();
    }
  });

  it('leave the log hosts to getJobLogs alone, as hosts it redirects to', () => {
    const withRedirectHosts = GITHUB_CONNECTOR.definition.endpoints.filter(
      (ep) => ep.redirectHosts !== undefined,
    );
    expect(withRedirectHosts.map((ep) => [ep.endpointId, ep.redirectHosts])).toEqual([
      ['getJobLogs', LOG_HOSTS],
    ]);
    const installed = GITHUB_API_DEFINITION.definition.endpoints.find(
      (ep) => ep.endpointId === 'getJobLogs',
    );
    expect(installed?.redirectHosts).toEqual(LOG_HOSTS);
  });
});
