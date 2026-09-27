/**
 * Illustration-specific validation — SVG security checks.
 *
 * Illustrations are pure SVG with no JavaScript. This validation ensures
 * the generated SVG is safe for inline rendering (dangerouslySetInnerHTML)
 * by stripping all JS execution vectors.
 */
import type { ValidationDiagnostic } from '@aflow/schemas';

export interface IllustrationValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

const MAX_SVG_SIZE = 128 * 1024; // 128KB

/**
 * Any `on*` attribute, not an enumeration of the ones in fashion — the DOM
 * gains event types faster than a list is maintained, and every miss is a
 * live handler.
 */
const EVENT_HANDLER_PATTERN = /\bon[a-z]+\s*=/gi;

/** Script-bearing URL schemes, tolerant of the whitespace/entities a parser strips. */
const SCRIPT_URL_PATTERN = /(?:javascript|vbscript)\s*:/gi;

/** External URL patterns in href/xlink:href attributes. */
const EXTERNAL_HREF_PATTERN = /(?:xlink:)?href\s*=\s*["']https?:\/\//gi;

/** External URL patterns in CSS url() references. */
const EXTERNAL_CSS_URL_PATTERN = /url\(\s*["']?https?:\/\//gi;

export function validateIllustration(source: string): IllustrationValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  // Size check
  if (new TextEncoder().encode(source).length > MAX_SVG_SIZE) {
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_SIZE_LIMIT',
      message: `SVG source exceeds ${MAX_SVG_SIZE / 1024}KB limit.`,
    });
    return { valid: false, diagnostics };
  }

  // Empty source check
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_EMPTY_SOURCE',
      message: 'SVG source is empty.',
    });
    return { valid: false, diagnostics };
  }

  // Must have <svg root element
  if (!/<svg[\s>]/i.test(trimmed)) {
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_NO_SVG_ROOT',
      message: 'SVG must have an <svg> root element.',
    });
    return { valid: false, diagnostics };
  }

  // Must have viewBox attribute
  if (!/\bviewBox\s*=\s*["']/i.test(trimmed)) {
    diagnostics.push({
      severity: 'warning',
      code: 'ILLUST_NO_VIEWBOX',
      message: 'SVG should have a viewBox attribute for responsive sizing.',
    });
  }

  // No <script> tags
  if (/<script[\s>]/gi.test(trimmed)) {
    const match = /<script[\s>]/gi.exec(trimmed);
    const line = match ? trimmed.slice(0, match.index).split('\n').length : undefined;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_SCRIPT_TAG',
      message: '<script> tags are not allowed in illustrations. SVG must be pure markup.',
      line,
    });
  }

  // No <foreignObject>
  if (/<foreignObject[\s>]/gi.test(trimmed)) {
    const match = /<foreignObject[\s>]/gi.exec(trimmed);
    const line = match ? trimmed.slice(0, match.index).split('\n').length : undefined;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_FOREIGN_OBJECT',
      message: '<foreignObject> is not allowed — it enables HTML injection.',
      line,
    });
  }

  // No <iframe>, <embed>, <object>, <base> — each can host or re-point a document
  const EMBEDDING_TAG_PATTERN = /<(iframe|embed|object|base)[\s>]/gi;
  EMBEDDING_TAG_PATTERN.lastIndex = 0;
  const embeddingMatch = EMBEDDING_TAG_PATTERN.exec(trimmed);
  if (embeddingMatch) {
    const line = trimmed.slice(0, embeddingMatch.index).split('\n').length;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_EMBEDDING_TAG',
      message: `<${embeddingMatch[1] ?? 'element'}> is not allowed — illustrations must be self-contained markup.`,
      line,
    });
  }

  // No event handler attributes
  EVENT_HANDLER_PATTERN.lastIndex = 0;
  const eventMatch = EVENT_HANDLER_PATTERN.exec(trimmed);
  if (eventMatch) {
    const line = trimmed.slice(0, eventMatch.index).split('\n').length;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_EVENT_HANDLER',
      message: `Event handler attribute "${eventMatch[0].replace(/\s*=$/, '')}" is not allowed. No JavaScript in illustrations.`,
      line,
    });
  }

  // No script-bearing URL schemes
  SCRIPT_URL_PATTERN.lastIndex = 0;
  const scriptUrlMatch = SCRIPT_URL_PATTERN.exec(trimmed);
  if (scriptUrlMatch) {
    const line = trimmed.slice(0, scriptUrlMatch.index).split('\n').length;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_SCRIPT_URL',
      message: `"${scriptUrlMatch[0]}" URLs are not allowed. No JavaScript in illustrations.`,
      line,
    });
  }

  // No external href/xlink:href
  EXTERNAL_HREF_PATTERN.lastIndex = 0;
  const hrefMatch = EXTERNAL_HREF_PATTERN.exec(trimmed);
  if (hrefMatch) {
    const line = trimmed.slice(0, hrefMatch.index).split('\n').length;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_EXTERNAL_HREF',
      message: 'External URLs in href/xlink:href are not allowed. Use inline data URIs instead.',
      line,
    });
  }

  // No external CSS url()
  EXTERNAL_CSS_URL_PATTERN.lastIndex = 0;
  const cssUrlMatch = EXTERNAL_CSS_URL_PATTERN.exec(trimmed);
  if (cssUrlMatch) {
    const line = trimmed.slice(0, cssUrlMatch.index).split('\n').length;
    diagnostics.push({
      severity: 'error',
      code: 'ILLUST_EXTERNAL_CSS_URL',
      message: 'External URLs in CSS url() are not allowed. Embed resources inline.',
      line,
    });
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  return { valid: !hasErrors, diagnostics };
}

/**
 * Wrap SVG in a minimal HTML document for iframe fallback and storage compatibility.
 * The html_ref column requires an HTML document; this provides one while keeping
 * the SVG as the primary rendering format via IllustrationRenderer.
 */
export function wrapIllustrationHtml(svg: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: transparent; }
  svg { max-width: 100%; max-height: 100vh; }
</style>
</head>
<body>
${svg}
</body>
</html>`;
}
