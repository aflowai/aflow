/**
 * Safety bounding for declared JSON Schemas (stateSchema, action inputSchema).
 * Generated schemas are untrusted runtime input: a keyword outside the
 * declared dialect subset is refused rather than silently ignored — a keyword
 * the validator would skip is a rule the author believes exists.
 */
import {
  APPLET_SCHEMA_ALLOWED_KEYWORDS,
  APPLET_SCHEMA_DIALECT,
  APPLET_SCHEMA_LOCAL_REF_PREFIX,
  APPLET_SCHEMA_MAX_BYTES,
  APPLET_SCHEMA_MAX_DEPTH,
  APPLET_SCHEMA_MAX_PATTERN_LENGTH,
} from '@aflow/schemas';
import { AppletSchemaSafetyError } from './errors.js';
import { exceedsJsonDepth, isJsonRecord, jsonUtf8Bytes } from './json.js';

const SINGLE_SUBSCHEMA_KEYWORDS = ['items', 'additionalProperties', 'propertyNames', 'not'];
const SUBSCHEMA_ARRAY_KEYWORDS = ['prefixItems', 'allOf', 'anyOf', 'oneOf'];
const SUBSCHEMA_MAP_KEYWORDS = ['properties', '$defs'];

export function assertAppletSchemaSafe(schema: Record<string, unknown>): void {
  const bytes = jsonUtf8Bytes(schema);
  if (bytes > APPLET_SCHEMA_MAX_BYTES) {
    throw new AppletSchemaSafetyError(
      'schema_too_large',
      `Schema serializes to ${bytes} bytes (max ${APPLET_SCHEMA_MAX_BYTES})`,
    );
  }
  if (exceedsJsonDepth(schema, APPLET_SCHEMA_MAX_DEPTH)) {
    throw new AppletSchemaSafetyError(
      'schema_too_deep',
      `Schema nests deeper than ${APPLET_SCHEMA_MAX_DEPTH} levels`,
    );
  }
  walkSchemaNode(schema, '#');
}

function walkSchemaNode(node: unknown, path: string): void {
  if (typeof node === 'boolean') return;
  if (!isJsonRecord(node)) {
    throw new AppletSchemaSafetyError(
      'schema_forbidden_keyword',
      `Schema node at ${path} is not an object or boolean`,
      path,
    );
  }
  for (const [keyword, value] of Object.entries(node)) {
    const keywordPath = `${path}/${keyword}`;
    if (!APPLET_SCHEMA_ALLOWED_KEYWORDS.has(keyword)) {
      throw new AppletSchemaSafetyError(
        'schema_forbidden_keyword',
        `Keyword '${keyword}' at ${keywordPath} is outside the declared dialect subset`,
        keywordPath,
      );
    }
    if (keyword === '$schema') {
      if (value !== APPLET_SCHEMA_DIALECT) {
        throw new AppletSchemaSafetyError(
          'schema_wrong_dialect',
          `Only '${APPLET_SCHEMA_DIALECT}' is accepted as $schema`,
          keywordPath,
        );
      }
      continue;
    }
    if (keyword === '$ref') {
      if (typeof value !== 'string' || !value.startsWith(APPLET_SCHEMA_LOCAL_REF_PREFIX)) {
        throw new AppletSchemaSafetyError(
          'schema_remote_ref',
          `$ref at ${keywordPath} must be document-local ('${APPLET_SCHEMA_LOCAL_REF_PREFIX}...')`,
          keywordPath,
        );
      }
      continue;
    }
    if (keyword === 'pattern') {
      if (typeof value !== 'string' || value.length > APPLET_SCHEMA_MAX_PATTERN_LENGTH) {
        throw new AppletSchemaSafetyError(
          'schema_pattern_too_long',
          `pattern at ${keywordPath} must be a string of at most ${APPLET_SCHEMA_MAX_PATTERN_LENGTH} characters`,
          keywordPath,
        );
      }
      continue;
    }
    if (SINGLE_SUBSCHEMA_KEYWORDS.includes(keyword)) {
      walkSchemaNode(value, keywordPath);
      continue;
    }
    if (SUBSCHEMA_ARRAY_KEYWORDS.includes(keyword)) {
      if (!Array.isArray(value)) {
        throw new AppletSchemaSafetyError(
          'schema_forbidden_keyword',
          `'${keyword}' at ${keywordPath} must be an array of schemas`,
          keywordPath,
        );
      }
      value.forEach((entry, index) => {
        walkSchemaNode(entry, `${keywordPath}/${index}`);
      });
      continue;
    }
    if (SUBSCHEMA_MAP_KEYWORDS.includes(keyword)) {
      if (!isJsonRecord(value)) {
        throw new AppletSchemaSafetyError(
          'schema_forbidden_keyword',
          `'${keyword}' at ${keywordPath} must be an object of schemas`,
          keywordPath,
        );
      }
      for (const [name, subschema] of Object.entries(value)) {
        walkSchemaNode(subschema, `${keywordPath}/${name}`);
      }
      continue;
    }
    // Remaining allowed keywords carry data, not schemas — nothing to walk.
  }
}

/**
 * Assert every JSON Schema a definition carries — stateSchema and each
 * action's inputSchema — against the applet safety bounds in one call.
 * Install paths use this so an unsafe schema fails at install, not at
 * the first act in a live space.
 */
export function assertAppletDefinitionSchemasSafe(definition: {
  stateSchema: Record<string, unknown>;
  actions: ReadonlyArray<{ name: string; inputSchema: Record<string, unknown> }>;
}): void {
  assertAppletSchemaSafe(definition.stateSchema);
  for (const action of definition.actions) {
    assertAppletSchemaSafe(action.inputSchema);
  }
}
