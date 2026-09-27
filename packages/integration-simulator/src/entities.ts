/**
 * Seed entities, checked against the collection schemas they claim to belong to.
 *
 * The collection schema is the contract a generated fact and an imported seed
 * row are both held to, so one checker answers both: a world whose entities
 * satisfy different rules depending on how they arrived is a world no
 * projection can be trusted against.
 */
import type { SimulationCollection } from '@aflow/schemas';
import { compileSchema, describeSchemaErrors, type CompiledSchema } from './schemaCheck.js';

export interface EntityViolation {
  collection: string;
  /** Index within the supplied array for that collection. */
  index: number;
  detail: string;
}

/** One entity ready to store: its identity and its body. */
export interface IdentifiedEntity {
  collection: string;
  entityId: string;
  body: Record<string, unknown>;
}

function identityOf(body: Record<string, unknown>, identityField: string): string | null {
  const raw = body[identityField];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

type CompiledCollection = { validate: CompiledSchema } | { detail: string };

function compileCollection(declaration: SimulationCollection): CompiledCollection {
  const compiled = compileSchema(declaration.schema);
  if (compiled.ok) return { validate: compiled.validate };
  return {
    detail: `Collection "${declaration.collection}" has a schema that does not compile: ${compiled.detail}`,
  };
}

/**
 * One entity on its way into the world, held to the collection it claims.
 *
 * Returns the reason it may not be stored, or `undefined` when it may. The
 * mutation path and the seed path share this checker: an entity that satisfies
 * different rules depending on whether it was seeded or written by an effect
 * is one no projection and no later read can be trusted against.
 */
export function entityStorageViolation(params: {
  declaration: SimulationCollection;
  entityId: string;
  body: Record<string, unknown>;
}): string | undefined {
  const { declaration, entityId, body } = params;
  const compiled = compileCollection(declaration);
  if ('detail' in compiled) return compiled.detail;

  const held = identityOf(body, declaration.identityField);
  if (held === null) {
    return `Entity "${entityId}" is missing its identity field "${declaration.identityField}", so nothing in "${declaration.collection}" can address it.`;
  }
  if (held !== entityId) {
    return `Entity "${entityId}" holds "${held}" in its identity field "${declaration.identityField}", so a later read would address it by a value the world does not store it under.`;
  }
  if (!compiled.validate(body)) {
    return `Entity "${entityId}" fails the "${declaration.collection}" collection schema: ${describeSchemaErrors(compiled.validate)}`;
  }
  return undefined;
}

/**
 * Entities keyed by collection, validated wholesale.
 *
 * A single failure returns violations and no entities: a partially stored world
 * is one whose reads answer from a fixture nobody authored.
 */
export function validateSeedEntities(params: {
  collections: readonly SimulationCollection[];
  entities: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}): { violations: EntityViolation[]; entities: IdentifiedEntity[] } {
  const declared = new Map(params.collections.map((c) => [c.collection, c]));
  const violations: EntityViolation[] = [];
  const accepted: IdentifiedEntity[] = [];

  for (const [collection, rows] of Object.entries(params.entities)) {
    const declaration = declared.get(collection);
    if (!declaration) {
      violations.push({
        collection,
        index: -1,
        detail: `Collection "${collection}" is not declared in the simulation's collections[]. Declare it first, or drop it from the payload.`,
      });
      continue;
    }
    const compiled = compileCollection(declaration);
    if ('detail' in compiled) {
      violations.push({ collection, index: -1, detail: compiled.detail });
      continue;
    }
    const validate = compiled.validate;
    const seen = new Set<string>();
    for (const [index, body] of rows.entries()) {
      const entityId = identityOf(body, declaration.identityField);
      if (entityId === null) {
        violations.push({
          collection,
          index,
          detail: `Entity is missing its identity field "${declaration.identityField}", so nothing can address it.`,
        });
        continue;
      }
      if (seen.has(entityId)) {
        violations.push({
          collection,
          index,
          detail: `Two entities share the identity "${entityId}"; one would silently overwrite the other.`,
        });
        continue;
      }
      seen.add(entityId);
      if (!validate(body)) {
        violations.push({
          collection,
          index,
          detail: `Entity "${entityId}" fails the collection schema: ${describeSchemaErrors(validate)}`,
        });
        continue;
      }
      accepted.push({ collection, entityId, body });
    }
  }

  return violations.length > 0 ? { violations, entities: [] } : { violations, entities: accepted };
}
