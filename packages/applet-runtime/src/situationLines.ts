/**
 * Declared situation pointers rendered as labeled lines — the applet's brief
 * of what a summoned agent must see. Rendered into read results at the
 * conversation tail, never into the prompt prefix: per-action content in the
 * prefix would re-read the whole conversation uncached every move.
 */
import type { AppletDefinition } from '@aflow/schemas';
import { resolveJsonPointer } from './pointer.js';

const SITUATION_VALUE_MAX = 400;

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function renderAppletSituationLines(
  definition: AppletDefinition,
  state: Record<string, unknown>,
): string[] {
  if (definition.situationProjection === undefined) return [];
  const lines: string[] = [];
  for (const pointer of definition.situationProjection) {
    const resolved = resolveJsonPointer(state, pointer);
    if (!resolved.found || resolved.value === undefined || resolved.value === null) continue;
    const label = pointer.split('/').filter(Boolean).pop() ?? pointer;
    const value = resolved.value;
    let rendered: string;
    if (typeof value === 'string') {
      if (value.length === 0) continue;
      rendered = value;
    } else if (Array.isArray(value)) {
      if (value.length === 0) continue;
      rendered = value
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join('; ');
    } else {
      rendered = JSON.stringify(value);
    }
    lines.push(`${label}: ${clamp(rendered, SITUATION_VALUE_MAX)}`);
  }
  return lines;
}
