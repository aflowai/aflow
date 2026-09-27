import type { ConnectorCatalogEntry, SkillBundleInput } from '@aflow/schemas';

type BundledApiDefinitionInput = NonNullable<SkillBundleInput['apiDefinitions']>[number];

type DraftDefinition = BundledApiDefinitionInput['definition'];
type DraftEndpoint = NonNullable<DraftDefinition['endpoints']>[number];
type DraftAuthKind = NonNullable<DraftDefinition['authKind']>;

const DRAFT_SUMMARY_MAX = 500;
const DRAFT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type DraftMethod = (typeof DRAFT_METHODS)[number];

function draftAuthKind(entry: ConnectorCatalogEntry): DraftAuthKind {
  if (entry.authKind === 'oauth2_authorization_code') return 'oauth2';
  return entry.authKind;
}

function draftMethod(catalogId: string, endpointId: string, method: string): DraftMethod {
  if (!(DRAFT_METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `Connector '${catalogId}' endpoint '${endpointId}' uses method '${method}', which the bundle draft shape does not carry.`,
    );
  }
  return method as DraftMethod;
}

/**
 * Derive a bundle-carried API definition from a connector catalog entry, so
 * a skill pack reuses the connector's vetted endpoint set instead of
 * hand-mirroring it. The connector embeds the full `ApiDefinition` model
 * while bundles carry the `ApiDefinitionDraft` authoring shape (install
 * re-synthesizes the full model via `synthesizeEndpoints`), so this is a
 * lowering, not a copy:
 *
 * - path params are NOT re-declared — install re-derives them from the
 *   `{placeholder}`s in the path template (their prose descriptions are the
 *   one fidelity loss);
 * - a `header`-located param has no draft representation, so it throws —
 *   forcing a decision rather than silently dropping an auth-relevant param;
 * - a `body` param must carry a schema (the draft body contract requires
 *   one), matching the registry-load superRefine on the connector side.
 *
 * Same apiId as the connector + `conflictPolicy: 'skip'` means whichever of
 * the standalone connector or the bundle installs first owns the space's
 * definition and the other's install leaves it untouched.
 */
export function bundledApiDefinitionFromConnector(
  entry: ConnectorCatalogEntry,
): BundledApiDefinitionInput {
  const source = entry.definition;
  if (source.baseUrl === undefined) {
    throw new Error(
      `Connector '${entry.catalogId}' uses baseUrlTemplate; bundle lowering only supports concrete-baseUrl connectors.`,
    );
  }

  const endpoints: DraftEndpoint[] = source.endpoints.map((ep) => {
    const header = ep.params.find((p) => p.location === 'header');
    if (header) {
      throw new Error(
        `Connector '${entry.catalogId}' endpoint '${ep.endpointId}' declares header param '${header.name}', which has no bundle-draft representation.`,
      );
    }
    const queryParams = ep.params
      .filter((p) => p.location === 'query')
      .map((p) => ({
        name: p.name,
        required: p.required,
        ...(p.description !== undefined
          ? { description: p.description.slice(0, DRAFT_SUMMARY_MAX) }
          : {}),
      }));
    const bodyParam = ep.params.find((p) => p.location === 'body');
    if (bodyParam && bodyParam.schema === undefined) {
      throw new Error(
        `Connector '${entry.catalogId}' endpoint '${ep.endpointId}' declares a body param without a schema.`,
      );
    }
    return {
      endpointId: ep.endpointId,
      name: ep.name,
      path: ep.pathTemplate,
      method: draftMethod(entry.catalogId, ep.endpointId, ep.method),
      ...(ep.responseTransformPresetId !== undefined
        ? { responseTransformPresetId: ep.responseTransformPresetId }
        : {}),
      ...(ep.description !== undefined
        ? { summary: ep.description.slice(0, DRAFT_SUMMARY_MAX) }
        : {}),
      ...(queryParams.length > 0 ? { queryParams } : {}),
      ...(bodyParam?.schema !== undefined
        ? {
            body: {
              contentType:
                ep.bodyEncoding === 'form-urlencoded'
                  ? ('application/x-www-form-urlencoded' as const)
                  : ep.bodyEncoding === 'form-data'
                    ? ('multipart/form-data' as const)
                    : ('application/json' as const),
              schema: bodyParam.schema,
              ...(bodyParam.description !== undefined
                ? { description: bodyParam.description.slice(0, DRAFT_SUMMARY_MAX) }
                : {}),
            },
          }
        : {}),
    };
  });

  return {
    apiId: source.apiId,
    definition: {
      name: source.name,
      baseUrl: source.baseUrl,
      authKind: draftAuthKind(entry),
      endpoints,
      ...(source.suggestedEgressPolicy !== undefined
        ? {
            suggestedEgressPolicy: {
              ...(source.suggestedEgressPolicy.allowedMethods !== undefined
                ? { allowedMethods: source.suggestedEgressPolicy.allowedMethods }
                : {}),
              ...(source.suggestedEgressPolicy.allowCrossHostRedirects !== undefined
                ? {
                    allowCrossHostRedirects: source.suggestedEgressPolicy.allowCrossHostRedirects,
                  }
                : {}),
              ...(source.suggestedEgressPolicy.additionalHosts !== undefined
                ? { additionalHosts: source.suggestedEgressPolicy.additionalHosts }
                : {}),
            },
          }
        : {}),
    },
    conflictPolicy: 'skip' as const,
  };
}
