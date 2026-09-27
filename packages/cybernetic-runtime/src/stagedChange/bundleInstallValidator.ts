import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  ApiDefinitionDraft,
  AuthShape,
  SkillBundle,
  SkillManifest,
  Workflow,
} from '@aflow/schemas';
import { validateSkillUiOutputShape } from '@aflow/schemas';
import { getSkillCatalogEntry } from '@aflow/platform-artifacts';

export type BundleInstallValidation =
  { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

export interface ValidateBundleInstallOpts {
  /** Bundle being installed. */
  bundle: SkillBundle;
  /** Target space (UUID). */
  spaceId: string;
  /** Caller-provided tenant-scoped transaction. */
  tx: PostgresJsDatabase;
  /** Resolve a prereq bundle by ID. Returns `null` for unknown ids. */
  resolveBundle: (bundleId: string) => SkillBundle | null;
  checkSkillInstalled: (catalogId: string) => Promise<boolean>;
  resolveSkill?: (catalogId: string) => { manifest: SkillManifest; workflow: Workflow } | null;
}

/**
 * Run all four preconditions per v5 §3.4.1 + the cross-bundle apiId
 * reference resolution. Returns a structured result the install op can
 * surface to the operator without further string-munging.
 *
 *  (a) every skill in `prereqBundle.skillCatalogIds[]` is `complete` in
 *      target space (per `checkSkillInstalled` — artifact presence today;
 *      promotable to `skill_installs` if/when that table lands)
 *  (b) every `prereq.apiDefinitions[].apiId` has an `api_definitions` row
 *      at `(apiId, spaceId)`
 *  (c) every `prereq.apiBindingTemplates[].bindingId` has an `api_bindings`
 *      row at `(bindingId, spaceId)`
 *  (d) every `apiId` referenced by THIS bundle's `apiBindingTemplates[]`
 *      resolves to `bundle.apiDefinitions ∪ installed_prereq_defs`
 */
export async function validateBundleInstallPreconditions(
  opts: ValidateBundleInstallOpts,
): Promise<BundleInstallValidation> {
  const { bundle, spaceId, tx, resolveBundle, checkSkillInstalled } = opts;
  const resolveSkill =
    opts.resolveSkill ??
    ((catalogId: string) => {
      const entry = getSkillCatalogEntry(catalogId);
      return entry ? { manifest: entry.bundle.manifest, workflow: entry.bundle.workflow } : null;
    });
  const errors: string[] = [];
  const warnings: string[] = [];

  // Defensive defaults — the Zod schema's `.default([])` only fires when a
  // caller actually parses the bundle. Test fixtures and other callers that
  const apiDefinitions = bundle.apiDefinitions ?? [];
  const apiBindingTemplates = bundle.apiBindingTemplates ?? [];
  const mcpDefinitions = bundle.mcpDefinitions ?? [];
  const mcpBindingTemplates = bundle.mcpBindingTemplates ?? [];

  // Resolve each declared prereq bundle. Unknown prereq id = hard error
  // (can't satisfy what we can't see); the install op surfaces this as
  // "prerequisite bundle not in catalog".
  const resolvedPrereqs: SkillBundle[] = [];
  for (const prereqId of bundle.prerequisiteBundleIds) {
    const prereq = resolveBundle(prereqId);
    if (!prereq) {
      errors.push(`Prerequisite bundle "${prereqId}" is not registered in the catalog.`);
      continue;
    }
    resolvedPrereqs.push(prereq);
  }

  // (a) Every prereq's skills must be complete in the target space.
  for (const prereq of resolvedPrereqs) {
    for (const skillId of prereq.skillCatalogIds) {
      const installed = await checkSkillInstalled(skillId);
      if (!installed) {
        errors.push(
          `Prerequisite bundle "${prereq.bundleId}" requires skill "${skillId}" installed in this space first.`,
        );
      }
    }
  }

  // (b) Every prereq's apiDefinitions must have a row at (apiId, spaceId).
  // (c) Every prereq's apiBindingTemplates must have a row at (bindingId, spaceId).
  for (const prereq of resolvedPrereqs) {
    const prereqApiDefs = prereq.apiDefinitions ?? [];
    const prereqBindings = prereq.apiBindingTemplates ?? [];
    if (prereqApiDefs.length > 0) {
      const apiIds = prereqApiDefs.map((d) => d.apiId);
      const existing = await tx.execute<{ api_id: string }>(sql`
        SELECT api_id FROM api_definitions
        WHERE space_id = ${spaceId}::uuid
          AND api_id IN ${sql.raw(`(${apiIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
      `);
      const present = new Set(existing.map((r) => r.api_id));
      for (const apiId of apiIds) {
        if (!present.has(apiId)) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" requires API definition "${apiId}" installed in this space first.`,
          );
        }
      }
    }

    if (prereqBindings.length > 0) {
      const bindingIds = prereqBindings.map((t) => t.bindingId);
      // SELECT api_id too so we can verify the installed binding actually
      // points at the API the prereq expects. A stale or hand-created row
      // with the same bindingId but a different api_id would otherwise
      const existing = await tx.execute<{ binding_id: string; api_id: string }>(sql`
        SELECT binding_id, api_id FROM api_bindings
        WHERE space_id = ${spaceId}::uuid
          AND binding_id IN ${sql.raw(`(${bindingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
      `);
      const apiIdByBindingId = new Map(existing.map((r) => [r.binding_id, r.api_id]));
      for (const tpl of prereqBindings) {
        const installedApiId = apiIdByBindingId.get(tpl.bindingId);
        if (installedApiId === undefined) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" requires API binding "${tpl.bindingId}" installed in this space first.`,
          );
        } else if (installedApiId !== tpl.apiId) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" expects binding "${tpl.bindingId}" to target api_id="${tpl.apiId}", but the installed binding targets api_id="${installedApiId}".`,
          );
        }
      }
    }
  }

  // (d) Every apiId referenced by THIS bundle's apiBindingTemplates must
  // resolve to bundle.apiDefinitions OR an installed prereq's apiDefinitions.
  // This is the work the schema-level refine used to do (and rightly didn't —
  // schema-load can't see prereqs). Prereqs are "installed" in the sense
  // confirmed by (b) above, so we trust their declared apiIds here. If (b)
  // failed for a given prereq, we've already emitted an error; treating
  // its apiIds as resolvable here would cascade misleading errors.
  //
  const authKindByApiId = new Map<string, ApiDefinitionDraft['authKind']>();
  for (const d of apiDefinitions) {
    authKindByApiId.set(d.apiId, d.definition.authKind);
  }
  for (const prereq of resolvedPrereqs) {
    for (const d of prereq.apiDefinitions ?? []) {
      authKindByApiId.set(d.apiId, d.definition.authKind);
    }
  }
  for (const tpl of apiBindingTemplates) {
    const authKind = authKindByApiId.get(tpl.apiId);
    if (authKind === undefined) {
      errors.push(
        `apiBindingTemplates[bindingId='${tpl.bindingId}'].apiId='${tpl.apiId}' does not resolve to this bundle.apiDefinitions[] or any prerequisite bundle's apiDefinitions[].`,
      );
      continue;
    }
    const expectedShape = authKindToShapeType(authKind);
    if (tpl.authShape.type !== expectedShape) {
      errors.push(
        `apiBindingTemplates[bindingId='${tpl.bindingId}'].authShape.type='${tpl.authShape.type}' does not match api_definition '${tpl.apiId}' authKind='${authKind}' (expected authShape.type='${expectedShape}').`,
      );
    }
  }

  for (const prereq of resolvedPrereqs) {
    const prereqMcpDefs = prereq.mcpDefinitions ?? [];
    const prereqMcpBindings = prereq.mcpBindingTemplates ?? [];

    if (prereqMcpDefs.length > 0) {
      const serverIds = prereqMcpDefs.map((d) => d.serverId);
      const existing = await tx.execute<{ server_id: string }>(sql`
        SELECT server_id FROM mcp_server_definitions
        WHERE space_id = ${spaceId}::uuid
          AND server_id IN ${sql.raw(`(${serverIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
      `);
      const present = new Set(existing.map((r) => r.server_id));
      for (const serverId of serverIds) {
        if (!present.has(serverId)) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" requires MCP server "${serverId}" installed in this space first.`,
          );
        }
      }
    }

    if (prereqMcpBindings.length > 0) {
      const bindingIds = prereqMcpBindings.map((t) => t.bindingId);
      const existing = await tx.execute<{ binding_id: string; server_id: string }>(sql`
        SELECT binding_id, server_id FROM mcp_server_bindings
        WHERE space_id = ${spaceId}::uuid
          AND binding_id IN ${sql.raw(`(${bindingIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')})`)}
      `);
      const serverIdByBindingId = new Map(existing.map((r) => [r.binding_id, r.server_id]));
      for (const tpl of prereqMcpBindings) {
        const installedServerId = serverIdByBindingId.get(tpl.bindingId);
        if (installedServerId === undefined) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" requires MCP binding "${tpl.bindingId}" installed in this space first.`,
          );
        } else if (installedServerId !== tpl.serverId) {
          errors.push(
            `Prerequisite bundle "${prereq.bundleId}" expects MCP binding "${tpl.bindingId}" to target server_id="${tpl.serverId}", but the installed binding targets server_id="${installedServerId}".`,
          );
        }
      }
    }
  }

  // (d') Cross-reference resolution for this bundle's MCP binding templates.
  const mcpServerIds = new Set<string>();
  for (const d of mcpDefinitions) mcpServerIds.add(d.serverId);
  for (const prereq of resolvedPrereqs) {
    for (const d of prereq.mcpDefinitions ?? []) mcpServerIds.add(d.serverId);
  }
  for (const tpl of mcpBindingTemplates) {
    if (!mcpServerIds.has(tpl.serverId)) {
      errors.push(
        `mcpBindingTemplates[bindingId='${tpl.bindingId}'].serverId='${tpl.serverId}' does not resolve to this bundle.mcpDefinitions[] or any prerequisite bundle's mcpDefinitions[].`,
      );
    }
  }

  const knownArtifactBindingIds = new Set<string>();
  for (const seed of bundle.artifactSeed ?? []) knownArtifactBindingIds.add(seed.bindingId);
  for (const prereq of resolvedPrereqs) {
    for (const seed of prereq.artifactSeed ?? []) knownArtifactBindingIds.add(seed.bindingId);
  }
  for (const skillCatalogId of bundle.skillCatalogIds) {
    const skillEntry = resolveSkill(skillCatalogId);
    if (!skillEntry) continue; // existence checked elsewhere; skip here
    const uiOutput = skillEntry.manifest.uiOutput;
    if (!uiOutput || uiOutput.kind === 'none') continue;

    // (e.1) Shape validation — terminal task matches uiOutput.kind AND
    // (PR #355 review fix) when kind='artifact', the terminal task's
    // `inputBindings.artifactId.bindingId` matches `uiOutput.bindingId`.
    // The validator reads only the `kind` and `bindingId` fields off
    // each binding, so the shape-compatible projection below is enough.
    const shapeErrors = validateSkillUiOutputShape(
      uiOutput,
      skillEntry.workflow.tasks.map((t) => ({
        taskId: t.taskId,
        ...(t.operation !== undefined ? { operation: t.operation } : {}),
        ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
        ...(t.inputBindings !== undefined
          ? {
              inputBindings: Object.fromEntries(
                Object.entries(t.inputBindings).map(([bindAs, b]) => [
                  bindAs,
                  {
                    kind: b.kind,
                    ...('bindingId' in b ? { bindingId: b.bindingId } : {}),
                  },
                ]),
              ),
            }
          : {}),
      })),
    );
    for (const err of shapeErrors) {
      errors.push(`skill '${skillCatalogId}' uiOutput.${err.kind}: ${err.detail}`);
    }

    // (e.2) Artifact-binding existence — uiOutput.kind='artifact' must
    // reference a known binding.
    if (uiOutput.kind === 'artifact' && !knownArtifactBindingIds.has(uiOutput.bindingId)) {
      errors.push(
        `skill '${skillCatalogId}' uiOutput.bindingId='${uiOutput.bindingId}' has no matching artifactSeed[].bindingId in this bundle or its prerequisites.`,
      );
    }
  }

  return errors.length === 0 ? { ok: true, warnings } : { ok: false, errors, warnings };
}

/**
 * Map an `ApiDefinitionDraft.authKind` to the corresponding
 * `AuthShape.type`. The two enums mostly align; the only non-trivial pair
 * is `oauth2` (definition draft) ↔ `oauth2_client_credentials` (auth profile).
 */
function authKindToShapeType(authKind: ApiDefinitionDraft['authKind']): AuthShape['type'] {
  switch (authKind) {
    case 'none':
      return 'none';
    case 'bearer':
      return 'bearer';
    case 'api_key':
      return 'api_key';
    case 'api_key_pair':
      return 'api_key_pair';
    case 'basic':
      return 'basic';
    case 'oauth2':
      return 'oauth2_client_credentials';
  }
}
