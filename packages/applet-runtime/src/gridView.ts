/**
 * Agent grid rendering — a declared cell-map state member materialized as a
 * labeled text grid at read time. Always computed from the state it is shown
 * with, so it can never be stale.
 */
import type { AppletAgentGrid } from '@aflow/schemas';
import { resolveJsonPointer } from './pointer.js';
import { isJsonRecord } from './json.js';

const CELL_MAX_CHARS = 4;

export function renderAppletAgentGrid(
  grid: AppletAgentGrid,
  state: Record<string, unknown>,
): string | undefined {
  const resolved = resolveJsonPointer(state, grid.mapPath);
  if (!resolved.found || !isJsonRecord(resolved.value)) return undefined;
  const map = resolved.value;

  const cell = (row: string, col: string): string => {
    const key = grid.keyOrder === 'rowCol' ? `${row}${col}` : `${col}${row}`;
    const value = map[key];
    if (typeof value !== 'string' || value === '') return grid.emptyAs;
    return value.slice(0, CELL_MAX_CHARS);
  };

  const width = Math.max(
    grid.emptyAs.length,
    ...grid.colLabels.map((label) => label.length),
    ...grid.rowLabels.flatMap((row) => grid.colLabels.map((col) => cell(row, col).length)),
  );
  const rowLabelWidth = Math.max(...grid.rowLabels.map((label) => label.length));
  const pad = (token: string): string => token.padStart(width);

  const lines: string[] = [];
  lines.push(`${' '.repeat(rowLabelWidth)} ${grid.colLabels.map((label) => pad(label)).join(' ')}`);
  for (const row of grid.rowLabels) {
    const cells = grid.colLabels.map((col) => pad(cell(row, col)));
    lines.push(`${row.padStart(rowLabelWidth)} ${cells.join(' ')}`);
  }
  if (grid.legend !== undefined && grid.legend.length > 0) {
    lines.push(grid.legend);
  }
  return lines.join('\n');
}
