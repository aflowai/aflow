/**
 * Template materialization — turning a declared template patch and a validated
 * action input into a concrete /state-confined RFC 6902 patch. Pure
 * substitution by typed reference: values ride pointers unchanged (no
 * coercion), and every input-derived path segment is RFC 6901-escaped.
 */
import {
  APPLET_JSON_POINTER_MAX_LENGTH,
  type AppletPatchPathTemplate,
  type AppletStatePatchOp,
  type AppletTemplatePatchOp,
} from '@aflow/schemas';
import { AppletTemplateError } from './errors.js';
import { escapeJsonPointerSegment, resolveJsonPointer } from './pointer.js';

interface TemplateScope {
  input: Record<string, unknown>;
}

export function materializeAppletTemplatePatch(
  template: readonly AppletTemplatePatchOp[],
  input: Record<string, unknown>,
): AppletStatePatchOp[] {
  const scope: TemplateScope = { input };
  return template.map((op, index) => materializeOp(op, scope, index));
}

function materializeOp(
  op: AppletTemplatePatchOp,
  scope: TemplateScope,
  opIndex: number,
): AppletStatePatchOp {
  if ((op.path !== undefined) === (op.pathTemplate !== undefined)) {
    throw new AppletTemplateError(
      'template_shape',
      `Template operation ${opIndex} must carry exactly one of path or pathTemplate`,
      opIndex,
    );
  }
  const path = op.path !== undefined ? op.path : materializePath(op.pathTemplate!, scope, opIndex);

  if (op.op === 'remove') {
    if (op.value !== undefined || op.valueFrom !== undefined) {
      throw new AppletTemplateError(
        'template_shape',
        `Template operation ${opIndex} is a 'remove' and carries no value or valueFrom`,
        opIndex,
      );
    }
    return { op: 'remove', path };
  }

  if ((op.value !== undefined) === (op.valueFrom !== undefined)) {
    throw new AppletTemplateError(
      'template_shape',
      `Template operation ${opIndex} ('${op.op}') must carry exactly one of value or valueFrom`,
      opIndex,
    );
  }
  if (op.valueFrom !== undefined) {
    const resolved = resolveJsonPointer(scope, op.valueFrom);
    if (!resolved.found) {
      throw new AppletTemplateError(
        'missing_input_value',
        `No value at '${op.valueFrom}' in the action input`,
        opIndex,
        op.valueFrom,
      );
    }
    return { op: op.op, path, value: structuredClone(resolved.value) };
  }
  return { op: op.op, path, value: structuredClone(op.value) };
}

/** Materialize a path template against an action input — shared with guard evaluation. */
export function materializeAppletPathTemplate(
  pathTemplate: AppletPatchPathTemplate,
  input: Record<string, unknown>,
): string {
  return materializePath(pathTemplate, { input }, 0);
}

function materializePath(
  pathTemplate: AppletPatchPathTemplate,
  scope: TemplateScope,
  opIndex: number,
): string {
  const [head, ...segments] = pathTemplate;
  let path = head;
  for (const segment of segments) {
    const token =
      typeof segment === 'string' ? segment : resolveSegmentToken(segment.from, scope, opIndex);
    path += `/${escapeJsonPointerSegment(token)}`;
  }
  if (path.length > APPLET_JSON_POINTER_MAX_LENGTH) {
    throw new AppletTemplateError(
      'materialized_path_too_long',
      `Template operation ${opIndex} materializes a pointer longer than ${APPLET_JSON_POINTER_MAX_LENGTH} characters`,
      opIndex,
    );
  }
  return path;
}

function resolveSegmentToken(pointer: string, scope: TemplateScope, opIndex: number): string {
  const resolved = resolveJsonPointer(scope, pointer);
  if (!resolved.found) {
    throw new AppletTemplateError(
      'missing_input_value',
      `No value at '${pointer}' in the action input`,
      opIndex,
      pointer,
    );
  }
  const value = resolved.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new AppletTemplateError(
    'segment_not_a_token',
    `Value at '${pointer}' is not usable as a path segment — expected a string or a non-negative integer`,
    opIndex,
    pointer,
  );
}
