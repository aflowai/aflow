/**
 * Drift guard: every API definition shipped in the platform registry must be
 * DEPLOYABLE — i.e. the exact definition_json the install path writes must
 * parse under the runtime `ApiDefinitionSchema` the api executor's space
 * loader uses. Bundle definitions are authored in the DRAFT shape
 * (`path`/`summary`/`queryParams`) and synthesized to the runtime shape
 * (`pathTemplate`/`description`/`params`) at install; validating only the
 * draft type lets a registry entry look valid while the executor's per-row
 * safeParse silently skips it at load — surfacing to agents as
 * "API definition not found in space".
 */
import { describe, it, expect } from 'vitest';
import { ApiDefinitionSchema } from '@aflow/schemas';
import { listSkillBundles, CONNECTOR_CATALOG } from '@aflow/platform-artifacts';
import { buildDefinitionJsonForDraft } from '../stagedChange/apiWriteHelpers.js';

function formatIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

describe('registry API definitions parse under the runtime ApiDefinitionSchema', () => {
  const bundles = listSkillBundles({ includeHidden: true });
  expect(bundles.length).toBeGreaterThan(0);

  for (const bundle of bundles) {
    for (const bundled of bundle.apiDefinitions) {
      it(`${bundle.bundleId} / ${bundled.apiId} synthesizes to a runtime-valid definition`, () => {
        const definitionJson = buildDefinitionJsonForDraft(bundled.apiId, bundled.definition);
        const result = ApiDefinitionSchema.safeParse(definitionJson);
        if (!result.success) {
          throw new Error(
            `Bundle "${bundle.bundleId}" definition "${bundled.apiId}" would be rejected by the ` +
              `api executor's loader (undeployable): ${formatIssues(result.error.issues)}`,
          );
        }
        expect(result.success).toBe(true);
      });
    }
  }

  for (const connector of CONNECTOR_CATALOG) {
    it(`connector ${connector.catalogId} embeds a runtime-valid definition`, () => {
      const result = ApiDefinitionSchema.safeParse(connector.definition);
      if (!result.success) {
        throw new Error(
          `Connector "${connector.catalogId}" definition would be rejected by the api ` +
            `executor's loader (undeployable): ${formatIssues(result.error.issues)}`,
        );
      }
      expect(result.success).toBe(true);
    });
  }
});
