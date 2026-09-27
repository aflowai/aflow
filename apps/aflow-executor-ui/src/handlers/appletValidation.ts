/**
 * Applet-specific validation — defense-in-depth security checks.
 *
 * The CSP in the HTML wrapper is the PRIMARY security boundary. This
 * validation layer catches obvious issues before they reach the iframe,
 * providing better error messages and preventing wasted generation cycles.
 */
import type { ValidationDiagnostic } from '@aflow/schemas';

export interface AppletValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

const MAX_SOURCE_SIZE = 256 * 1024; // 256KB

/** Patterns that indicate security issues in applet source code. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; code: string; message: string }> = [
  {
    pattern: /\beval\s*\(/g,
    code: 'APPLET_EVAL',
    message: 'eval() is not allowed in applets. Use direct code execution instead.',
  },
  {
    pattern: /\bnew\s+Function\s*\(/g,
    code: 'APPLET_FUNCTION_CONSTRUCTOR',
    message: 'new Function() is not allowed in applets.',
  },
  {
    pattern: /\b__proto__\b/g,
    code: 'APPLET_PROTO_ACCESS',
    message: '__proto__ access is not allowed in applets.',
  },
  {
    pattern: /\bdocument\s*\.\s*cookie\b/g,
    code: 'APPLET_COOKIE_ACCESS',
    message: 'document.cookie access is not allowed in applets.',
  },
  {
    pattern: /\bdocument\s*\.\s*write\s*\(/g,
    code: 'APPLET_DOCUMENT_WRITE',
    message: 'document.write() is not allowed. Append elements to document.body instead.',
  },
];

/** Patterns in HTML markup that indicate external resource loading. */
const DANGEROUS_HTML_PATTERNS: Array<{ pattern: RegExp; code: string; message: string }> = [
  {
    pattern: /<script\s+[^>]*\bsrc\s*=/gi,
    code: 'APPLET_EXTERNAL_SCRIPT',
    message:
      'External <script src="..."> tags are not allowed. Libraries are injected by the runtime.',
  },
  {
    pattern: /<iframe[\s>]/gi,
    code: 'APPLET_IFRAME',
    message: '<iframe> elements are not allowed in applets.',
  },
  {
    pattern: /<link\s+[^>]*\bhref\s*=\s*["']https?:/gi,
    code: 'APPLET_EXTERNAL_STYLESHEET',
    message: 'External stylesheets are not allowed. Use inline <style> tags instead.',
  },
];

/**
 * Validate applet source code (JS/HTML fragment that runs inside the wrapper).
 * Defense-in-depth — the iframe sandbox + CSP are the primary security boundary.
 */
export function validateApplet(source: string): AppletValidationResult {
  const diagnostics: ValidationDiagnostic[] = [];

  // Size check
  if (new TextEncoder().encode(source).length > MAX_SOURCE_SIZE) {
    diagnostics.push({
      severity: 'error',
      code: 'APPLET_SIZE_LIMIT',
      message: `Applet source exceeds ${MAX_SOURCE_SIZE / 1024}KB limit.`,
    });
    return { valid: false, diagnostics };
  }

  // Empty source check
  if (source.trim().length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'APPLET_EMPTY_SOURCE',
      message: 'Applet source code is empty.',
    });
    return { valid: false, diagnostics };
  }

  // Dangerous JS patterns
  for (const { pattern, code, message } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(source);
    if (match) {
      const line = source.slice(0, match.index).split('\n').length;
      diagnostics.push({ severity: 'error', code, message, line });
    }
  }

  // Dangerous HTML patterns
  for (const { pattern, code, message } of DANGEROUS_HTML_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(source);
    if (match) {
      const line = source.slice(0, match.index).split('\n').length;
      diagnostics.push({ severity: 'error', code, message, line });
    }
  }

  // Note: <script src>, <iframe>, <link href="http..."> patterns above catch
  // code that tries to load external resources. The CSP in the wrapper blocks
  // these at runtime too — this is defense-in-depth.

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  return { valid: !hasErrors, diagnostics };
}
