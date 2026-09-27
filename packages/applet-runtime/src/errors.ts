/**
 * Typed errors for the applet gateway's structural checks. Every error carries
 * a machine-readable `code` so callers can map to the two agent-facing failure
 * kinds (non-retryable rejection vs retryable version conflict) without
 * parsing messages.
 */

export class AppletRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AppletRuntimeError';
    this.code = code;
  }
}

export type AppletPointerErrorCode = 'malformed_pointer';

export class AppletPointerError extends AppletRuntimeError {
  declare readonly code: AppletPointerErrorCode;
  readonly pointer: string;

  constructor(code: AppletPointerErrorCode, message: string, pointer: string) {
    super(code, message);
    this.name = 'AppletPointerError';
    this.pointer = pointer;
  }
}

export type AppletPatchBoundsCode =
  | 'patch_empty'
  | 'patch_too_many_ops'
  | 'patch_too_large'
  | 'patch_outside_state'
  | 'pointer_too_long'
  | 'patch_value_too_deep';

export class AppletPatchBoundsError extends AppletRuntimeError {
  declare readonly code: AppletPatchBoundsCode;
  readonly opIndex?: number;
  readonly path?: string;

  constructor(code: AppletPatchBoundsCode, message: string, opIndex?: number, path?: string) {
    super(code, message);
    this.name = 'AppletPatchBoundsError';
    if (opIndex !== undefined) this.opIndex = opIndex;
    if (path !== undefined) this.path = path;
  }
}

export type AppletTemplateErrorCode =
  'template_shape' | 'missing_input_value' | 'segment_not_a_token' | 'materialized_path_too_long';

export class AppletTemplateError extends AppletRuntimeError {
  declare readonly code: AppletTemplateErrorCode;
  readonly opIndex?: number;
  readonly pointer?: string;

  constructor(code: AppletTemplateErrorCode, message: string, opIndex?: number, pointer?: string) {
    super(code, message);
    this.name = 'AppletTemplateError';
    if (opIndex !== undefined) this.opIndex = opIndex;
    if (pointer !== undefined) this.pointer = pointer;
  }
}

export type AppletCommandErrorCode = 'unknown_action' | 'patch_forbidden' | 'patch_required';

export class AppletCommandError extends AppletRuntimeError {
  declare readonly code: AppletCommandErrorCode;
  /** The declared surface — never domain legality, which the platform cannot judge. */
  readonly availableActions?: string[];

  constructor(code: AppletCommandErrorCode, message: string, availableActions?: string[]) {
    super(code, message);
    this.name = 'AppletCommandError';
    if (availableActions !== undefined) this.availableActions = availableActions;
  }
}

export type AppletPatchApplyCode = 'apply_failed' | 'state_shape_lost';

export class AppletPatchApplyError extends AppletRuntimeError {
  declare readonly code: AppletPatchApplyCode;
  readonly opIndex?: number;
  readonly path?: string;

  constructor(code: AppletPatchApplyCode, message: string, opIndex?: number, path?: string) {
    super(code, message);
    this.name = 'AppletPatchApplyError';
    if (opIndex !== undefined) this.opIndex = opIndex;
    if (path !== undefined) this.path = path;
  }
}

export type AppletSchemaSafetyCode =
  | 'schema_too_large'
  | 'schema_too_deep'
  | 'schema_forbidden_keyword'
  | 'schema_remote_ref'
  | 'schema_pattern_too_long'
  | 'schema_wrong_dialect'
  | 'schema_compile_failed';

/** A declared JSON Schema violated the safety bounds — generated schemas are untrusted runtime input. */
export class AppletSchemaSafetyError extends AppletRuntimeError {
  declare readonly code: AppletSchemaSafetyCode;
  readonly schemaPath?: string;

  constructor(code: AppletSchemaSafetyCode, message: string, schemaPath?: string) {
    super(code, message);
    this.name = 'AppletSchemaSafetyError';
    if (schemaPath !== undefined) this.schemaPath = schemaPath;
  }
}

export type AppletPersistenceErrorCode =
  | 'instance_not_found'
  | 'definition_missing'
  | 'definition_invalid'
  | 'state_missing'
  | 'state_corrupt';

/**
 * Infrastructure failures on the persistence port — never a command rejection.
 * A missing instance is a 404-shaped caller error; the rest indicate a broken
 * pinning or a corrupted snapshot and must surface loudly.
 */
export class AppletPersistenceError extends AppletRuntimeError {
  declare readonly code: AppletPersistenceErrorCode;
  readonly instanceId: string;

  constructor(code: AppletPersistenceErrorCode, message: string, instanceId: string) {
    super(code, message);
    this.name = 'AppletPersistenceError';
    this.instanceId = instanceId;
  }
}
