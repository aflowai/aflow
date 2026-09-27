/**
 * Artifact content hashing — the one authority for `installedContentHash` on
 * `store_install_artifacts` rows. The same functions stamp the hash at
 * install/update time (from registry content) and judge the current space
 * state at divergence time, so "customized" can never be an artifact of two
 * hashers disagreeing about serialization.
 */
import { stableHash, SkillComposeBundleSchema, WorkflowSchema } from '@aflow/schemas';
import {
  buildSkillWorkflowDoc,
  materializeSkillComposeBundle,
} from '../stagedChange/skillComposeApply.js';

/**
 * Hash after a JSON round-trip so code-built objects (which may carry
 * undefined-valued keys) and JSON.parse'd DB/doc content serialize
 * identically.
 */
export function jsonContentHash(value: unknown): string {
  return stableHash(JSON.parse(JSON.stringify(value)));
}

/**
 * Fields the installer/updater owns on a workflow doc — never part of the
 * artifact's content identity (update preserves them; every write moves
 * `updatedAt`).
 */
const SKILL_DOC_LIFECYCLE_FIELDS = new Set([
  'id',
  'status',
  'origin',
  'revision',
  'createdAt',
  'updatedAt',
]);

const HASH_IDENTITY = {
  id: '00000000-0000-0000-0000-000000000000',
  status: 'approved',
  origin: 'cloned',
  revision: 1,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** A space workflow doc's content identity (lifecycle fields stripped). */
export function skillDocContent(doc: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (SKILL_DOC_LIFECYCLE_FIELDS.has(key)) continue;
    content[key] = value;
  }
  return content;
}

/** Content hash of a space's workflow doc (lifecycle fields stripped). */
export function skillDocContentHash(doc: Record<string, unknown>): string {
  return jsonContentHash(skillDocContent(doc));
}

/**
 * A registry skill bundle's content identity *as an install would write it*:
 * clone, materialize, assemble the workflow doc with a fixed identity,
 * normalize through WorkflowSchema, strip the identity back out. Equals
 * {@link skillDocContent} of the doc a pristine install produced.
 */
export function skillBundleContentDoc(rawBundle: unknown): Record<string, unknown> {
  const bundle = SkillComposeBundleSchema.parse(JSON.parse(JSON.stringify(rawBundle)));
  const { materializedTasks } = materializeSkillComposeBundle(bundle);
  bundle.workflow.tasks = materializedTasks;
  const doc = buildSkillWorkflowDoc(bundle, HASH_IDENTITY);
  const parsed = WorkflowSchema.safeParse(doc);
  return skillDocContent(parsed.success ? (parsed.data as Record<string, unknown>) : doc);
}

export function skillBundleContentHash(rawBundle: unknown): string {
  return jsonContentHash(skillBundleContentDoc(rawBundle));
}

/** Content hash of a stored `api_definitions.definition_json`. */
export function apiDefinitionRowContentHash(definitionJson: unknown): string {
  return jsonContentHash(definitionJson);
}

/**
 * Content hash of a stored `mcp_server_definitions.definition_json`. The row
 * carries an install-stamped `source` that is not registry content — strip it
 * so the hash matches the registry-side stamp (`{ serverId, ...definition }`).
 */
export function mcpDefinitionRowContentHash(definitionJson: Record<string, unknown>): string {
  const { source: _source, ...content } = definitionJson;
  return jsonContentHash(content);
}
