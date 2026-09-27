/**
 * Response transform presets for API calls.
 *
 * Two families share the preset-id namespace:
 * - object presets (unwrap_data, first_item, extract:, pick:) reshape an
 *   already-parsed JSON body; unknown ids and failures fall back soft.
 * - text presets (TEXT_TRANSFORM_PRESETS) normalize a raw non-JSON body into
 *   typed JSON records BEFORE inline/reference shaping; they are fail-loud
 *   (API_RESPONSE_TRANSFORM_FAILED) because a silent raw-body fallback would
 *   hand the agent the format the transform exists to remove.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { apiError } from '../../lib/api-errors.js';
import { parseArxivAtomFeed } from './arxivAtom.js';
import { ApiExecutionError } from './types.js';

const TEXT_TRANSFORM_PRESETS: Record<string, (text: string) => unknown> = {
  arxiv_atom_papers: parseArxivAtomFeed,
};

/** The text-preset transform for an id, or undefined when the id names no text preset. */
export function getTextTransform(
  presetId: string | undefined,
): ((text: string) => unknown) | undefined {
  if (presetId === undefined) return undefined;
  return TEXT_TRANSFORM_PRESETS[presetId];
}

export function applyTextTransformPreset(
  presetId: string,
  text: string,
  extraDetails: Record<string, unknown> = {},
): unknown {
  const transform = TEXT_TRANSFORM_PRESETS[presetId];
  if (transform === undefined) {
    throw new ApiExecutionError(
      apiError('API_RESPONSE_TRANSFORM_FAILED', `Unknown text transform preset '${presetId}'.`, {
        retryable: false,
        details: { presetId, ...extraDetails },
      }),
    );
  }
  try {
    return transform(text);
  } catch (err) {
    throw new ApiExecutionError(
      apiError(
        'API_RESPONSE_TRANSFORM_FAILED',
        `Response transform '${presetId}' failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: false, details: { presetId, ...extraDetails } },
      ),
    );
  }
}

export function applyTransformPreset(
  presetId: string,
  body: unknown,
  ctx: ExecutorContext,
): unknown {
  try {
    if (presetId === 'unwrap_data') {
      return extractPath(body, 'data');
    }
    if (presetId === 'first_item') {
      return Array.isArray(body) ? (body[0] ?? null) : body;
    }
    if (presetId.startsWith('extract:')) {
      const path = presetId.slice('extract:'.length);
      return extractPath(body, path);
    }
    if (presetId.startsWith('pick:')) {
      const fields = presetId
        .slice('pick:'.length)
        .split(',')
        .map((f) => f.trim());
      return pickFields(body, fields);
    }
    ctx.log.warn('Unknown transform preset, returning body unchanged', { presetId });
    return body;
  } catch (err) {
    ctx.log.warn('Transform preset failed, returning original body', {
      presetId,
      error: err instanceof Error ? err.message : String(err),
    });
    return body;
  }
}

function extractPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function pickFields(body: unknown, fields: string[]): unknown {
  const pick = (obj: unknown): unknown => {
    if (typeof obj !== 'object' || obj === null) return obj;
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in obj) {
        result[field] = (obj as Record<string, unknown>)[field];
      }
    }
    return result;
  };

  if (Array.isArray(body)) return body.map(pick);
  return pick(body);
}

export function validateAgainstJsonSchema(
  body: unknown,
  schema: Record<string, unknown>,
): string[] {
  const issues: string[] = [];
  const type = schema['type'] as string | undefined;

  if (type === 'object' && (typeof body !== 'object' || body === null || Array.isArray(body))) {
    issues.push(`Expected object, got ${Array.isArray(body) ? 'array' : typeof body}`);
    return issues;
  }
  if (type === 'array' && !Array.isArray(body)) {
    issues.push(`Expected array, got ${typeof body}`);
    return issues;
  }

  if (type === 'object' && typeof body === 'object' && body !== null) {
    const required = (schema['required'] ?? []) as string[];
    for (const field of required) {
      if (!(field in body)) {
        issues.push(`Missing required field: ${field}`);
      }
    }
  }

  return issues;
}
