/**
 * AST-level semantic validation for generated UI artifacts.
 *
 * Lightweight, deterministic checks that run before or alongside esbuild
 * compilation. Catches common generation mistakes that would produce
 * confusing runtime errors.
 *
 * Spec 4 of Track A follow-up hardening.
 */
import type { ValidationDiagnostic } from '@aflow/schemas';

// ============================================================================
// Checks
// ============================================================================

/**
 * Check for missing default export — the artifact must export a default
 * component for the render shell to mount.
 */
function checkDefaultExport(source: string): ValidationDiagnostic[] {
  // Match: export default function/class/const, or export { X as default }
  const hasDefaultExport =
    /export\s+default\s+/.test(source) || /export\s*\{[^}]*\bas\s+default\b/.test(source);

  if (!hasDefaultExport) {
    return [
      {
        severity: 'error',
        code: 'AST_MISSING_DEFAULT_EXPORT',
        message:
          'No default export found. The artifact must have a default exported React component.',
      },
    ];
  }
  return [];
}

/**
 * Check for JSX components used but not imported and not locally defined.
 */
function checkUndefinedComponents(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Collect imported names
  const importedNames = new Set<string>();

  // Named imports: import { Foo, Bar } from '...'
  const namedImportRe = /import\s*\{([^}]+)\}\s*from/g;
  let m: RegExpExecArray | null;
  while ((m = namedImportRe.exec(source)) !== null) {
    const names = m[1]!.split(',');
    for (const n of names) {
      const cleaned = n.trim().split(/\s+as\s+/);
      const localName = (cleaned.length > 1 ? cleaned[1] : cleaned[0])?.trim();
      if (localName) importedNames.add(localName);
    }
  }

  // Default imports: import React from '...'
  const defaultImportRe = /import\s+(\w+)\s+from/g;
  while ((m = defaultImportRe.exec(source)) !== null) {
    importedNames.add(m[1]!);
  }

  // Also default + named: import React, { useState } from '...'
  const comboImportRe = /import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from/g;
  while ((m = comboImportRe.exec(source)) !== null) {
    importedNames.add(m[1]!);
    const names = m[2]!.split(',');
    for (const n of names) {
      const cleaned = n.trim().split(/\s+as\s+/);
      const localName = (cleaned.length > 1 ? cleaned[1] : cleaned[0])?.trim();
      if (localName) importedNames.add(localName);
    }
  }

  // Collect locally defined components (function/const declarations)
  const funcDeclRe = /(?:function|const|let|var)\s+([A-Z]\w*)/g;
  const definedNames = new Set<string>();
  while ((m = funcDeclRe.exec(source)) !== null) {
    definedNames.add(m[1]!);
  }

  // Standard React names that are always available
  const builtins = new Set(['React', 'Fragment']);

  // Find JSX usage
  const jsxRe = /<([A-Z][A-Za-z0-9]*)\b/g;
  const usedComponents = new Set<string>();
  while ((m = jsxRe.exec(source)) !== null) {
    usedComponents.add(m[1]!);
  }

  for (const name of usedComponents) {
    if (!importedNames.has(name) && !definedNames.has(name) && !builtins.has(name)) {
      diagnostics.push({
        severity: 'warning',
        code: 'AST_UNDEFINED_COMPONENT',
        message: `Component <${name}> is used in JSX but is neither imported nor locally defined.`,
      });
    }
  }

  return diagnostics;
}

/**
 * Check for unsafe data access patterns on the canonical `data` prop.
 */
function checkUnsafeDataAccess(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Detect direct property access on `data.xxx` without optional chaining
  // in map/forEach callbacks — common crash pattern
  const unsafeMapRe = /data\.(\w+)\.map\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = unsafeMapRe.exec(source)) !== null) {
    const prop = m[1]!;
    const line = source.substring(0, m.index).split('\n').length;
    diagnostics.push({
      severity: 'warning',
      code: 'AST_UNSAFE_DATA_MAP',
      message: `Unsafe \`data.${prop}.map()\` — use \`data.${prop}?.map()\` or guard with \`Array.isArray()\` for defensive rendering.`,
      line,
    });
  }

  // Detect rendering raw objects: {data} or {data.something} where something
  // could be an object (heuristic: no .toString(), .length, etc.)
  const rawObjectRenderRe = /\{data\}/g;
  while ((m = rawObjectRenderRe.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    diagnostics.push({
      severity: 'warning',
      code: 'AST_RAW_OBJECT_RENDER',
      message:
        'Rendering `{data}` directly may cause "[object Object]". Access specific fields instead.',
      line,
    });
  }

  return diagnostics;
}

/**
 * Check for embedded primary domain data — large literal arrays/objects
 * that look like fixture data which should be externalized to the data prop.
 */
function checkEmbeddedData(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Detect large array literals (5+ elements with object shapes) outside of data prop usage
  // Heuristic: array with 5+ object entries assigned to a const/let/var
  const largeArrayRe = /(?:const|let|var)\s+\w+\s*(?::\s*\w[^=]*)?\s*=\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = largeArrayRe.exec(source)) !== null) {
    // Count how many object entries follow
    const after = source.substring(m.index, Math.min(m.index + 2000, source.length));
    const objectCount = (after.match(/\{/g) ?? []).length;
    if (objectCount >= 5) {
      const line = source.substring(0, m.index).split('\n').length;
      diagnostics.push({
        severity: 'warning',
        code: 'AST_EMBEDDED_DATA',
        message:
          'Large literal array detected — primary domain data should come from the data prop, not be embedded in source.',
        line,
      });
    }
  }

  return diagnostics;
}

/**
 * Check for Panel used as a likely fake divider — thin Panel with no children
 * or minimal styling that should use Divider instead.
 */
function checkFakeDivider(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Detect <Panel with very small padding and no children or minimal content
  const fakeDividerRe = /<Panel[^>]*(?:padding=["'](?:none|xs)["']|height=["']\d+px["'])[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = fakeDividerRe.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    diagnostics.push({
      severity: 'warning',
      code: 'AST_FAKE_DIVIDER',
      message: 'Panel used as a likely divider — use <Divider /> instead.',
      line,
    });
  }

  return diagnostics;
}

/**
 * Check for collections built ad-hoc with Column + repeated Panels/Cards
 * instead of using List + ListItem.
 */
function checkAdHocCollection(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Heuristic: .map() returning <Panel> or <Card> wrapped in <Column>
  // Pattern: something.map(...) containing <Panel or <Card, inside a <Column>
  const mapPanelRe = /\.map\s*\([^)]*\)\s*(?:=>|{\s*return)\s*[\s\S]*?<(?:Panel|Card)\b/g;
  let m: RegExpExecArray | null;
  while ((m = mapPanelRe.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    diagnostics.push({
      severity: 'warning',
      code: 'AST_ADHOC_COLLECTION',
      message:
        'Mapping data to individual Panel/Card elements — consider using <List dividers> with <ListItem> for consistent collection rendering.',
      line,
    });
  }

  return diagnostics;
}

/**
 * Check for Row/Column containers without fill on any child — common cause
 * of unexpectedly squeezed layouts when content should expand.
 */
function checkMissingFill(source: string): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];

  // Heuristic: <Row with justify="between" containing multiple children but no child has fill
  // This is a common pattern where the model uses justify="between" when fill would be cleaner
  // We only flag if there's a Spacer between children (manual spacing hack)
  const spacerInRowRe = /<Row[^>]*>[\s\S]*?<Spacer\s*\/>[\s\S]*?<\/Row>/g;
  let m: RegExpExecArray | null;
  while ((m = spacerInRowRe.exec(source)) !== null) {
    const line = source.substring(0, m.index).split('\n').length;
    diagnostics.push({
      severity: 'warning',
      code: 'AST_SPACER_IN_ROW',
      message:
        'Spacer inside Row — consider using `fill` on the expanding child instead, or `justify="between"` on the Row.',
      line,
    });
  }

  return diagnostics;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run all AST-level semantic validation checks.
 * Returns diagnostics with `AST_*` codes, distinguishable from esbuild/syntax errors.
 */
export function runAstValidation(source: string): ValidationDiagnostic[] {
  return [
    ...checkDefaultExport(source),
    ...checkUndefinedComponents(source),
    ...checkUnsafeDataAccess(source),
    ...checkEmbeddedData(source),
    ...checkFakeDivider(source),
    ...checkAdHocCollection(source),
    ...checkMissingFill(source),
  ];
}
