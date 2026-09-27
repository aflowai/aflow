/**
 * Render-boundary sanitizer for agent- and user-authored SVG.
 *
 * SVG reaching the DOM is untrusted regardless of where it was validated on
 * the way in: generation-time checks describe what a well-behaved producer
 * emits, they do not constrain what is already stored. Anything inlined into
 * this origin passes through here first.
 *
 * An allowlist parser is used rather than pattern matching because the attack
 * surface is the browser's own parsing — namespace confusion, entity decoding,
 * attribute-name casing, and malformed-tag recovery all produce live event
 * handlers out of markup that no denylist recognises.
 */
import DOMPurify, { type Config } from 'dompurify';

const SVG_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Same-origin HTML smuggled through an SVG subtree, and the one element that
  // can re-point a whole document.
  FORBID_TAGS: ['foreignObject', 'script', 'base', 'iframe', 'embed', 'object', 'a'],
  // `href` on <use> resolves external documents; `target` only exists to
  // navigate. Neither has a use in a self-contained illustration.
  FORBID_ATTR: ['target', 'ping', 'formaction'],
};

/** The attributes that cause the browser to resolve a URL. */
const URL_ATTRIBUTES = ['href', 'xlink:href', 'src'];

/**
 * Control characters and whitespace are stripped before matching, because the
 * URL parser ignores them — `\u0000#x` and ` #x` resolve the same way, so a
 * pattern that did not strip them first could be stepped around.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const URL_IGNORED_CHARS = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/**
 * Every URL an illustration may reference: a same-document fragment, or an
 * inline image. Notably absent is `http(s):` — a remote reference in an
 * `<image>`, `<use>`, or `<feImage>` is a beacon reporting who viewed the
 * document and when, even though it cannot execute anything.
 *
 * This is applied per-attribute through a hook rather than through
 * `ALLOWED_URI_REGEXP`, which DOMPurify tests against *every* attribute value
 * outside its URI-safe list — a tight pattern there strips `d`, `cx`, and
 * `stroke` along with the URLs.
 */
const ALLOWED_URL = /^(?:#[\w.:-]*|data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]*)$/i;

/**
 * CSS is not parsed by the sanitizer, so a `<style>` block is admitted whole
 * or not at all. These two constructs are the ones that reach the network.
 */
const CSS_EXTERNAL_REFERENCE = /@import|url\s*\(\s*['"]?\s*(?:https?:)?\/\//i;

let purifier: ReturnType<typeof DOMPurify> | null = null;

/** Scoped instance — the URL hook must not apply to unrelated sanitize calls. */
function getPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;

  const instance = DOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;
    for (const attribute of URL_ATTRIBUTES) {
      const value = node.getAttribute(attribute);
      if (value !== null && !ALLOWED_URL.test(value.replace(URL_IGNORED_CHARS, ''))) {
        node.removeAttribute(attribute);
      }
    }
  });

  purifier = instance;
  return instance;
}

/**
 * Returns sanitized SVG markup, or an empty string when the input contains no
 * SVG at all — callers render nothing rather than a partial document.
 */
export function sanitizeSvg(source: string): string {
  if (typeof window === 'undefined') return '';

  const clean = getPurifier().sanitize(source, SVG_CONFIG);
  if (!/<svg[\s>]/i.test(clean)) return '';

  // `<style>` survives because illustrations carry their own theming custom
  // properties and `@keyframes`. Its document-wide reach is contained by
  // rendering into a shadow root (see `SafeSvg`) — what a shadow root does not
  // contain is a network fetch, so a block that reaches out is dropped whole
  // rather than partially rewritten.
  return clean.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (block, css: string) =>
    CSS_EXTERNAL_REFERENCE.test(css) ? '' : block,
  );
}
