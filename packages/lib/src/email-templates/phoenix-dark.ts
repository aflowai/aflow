/**
 * Phoenix dark transactional email shell — aligns with design-system dark tokens
 * and self-hosted Lato on cdn.aflow.ai (see packages/design-system/fonts/lato/lato.css).
 *
 * Inline CSS + <style> for clients that support @font-face; system stack fallback always applies.
 */

/** Mirrors `packages/design-system/tokens/tokens.json` dark semantic colors used in email. */
export const PHOENIX_EMAIL_DARK_COLORS = {
  canvas: '#0f0f0f',
  raised: '#171717',
  overlay: '#212121',
  border: '#2e2e2e',
  borderSubtle: '#252525',
  textPrimary: '#d7d4c3',
  textSecondary: '#a3a3a3',
  textMuted: '#6b6b6b',
  /** Headings / strong emphasis on dark surfaces (near-white). */
  textStrong: '#fafafa',
  accent: '#a48ad4',
  accentBg: '#1f1a2b',
  link: '#b89edf',
  codeBackground: '#1a1a1a',
} as const;

export type PhoenixEmailDarkColors = typeof PHOENIX_EMAIL_DARK_COLORS;

export const PHOENIX_EMAIL_FONT_FAMILY =
  "'Lato', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Header mark — hosted PNG (not SVG: poor email client support; not data: URI: often blocked e.g. Gmail).
 * Cloudinary `w_40` matches ~20px CSS width at 2x DPR; `q_auto` keeps payload small.
 */
export const AFLOW_EMAIL_LOGO_IMAGE_URL =
  'https://res.cloudinary.com/dr81sh2e0/image/upload/w_40,h_40,c_fit,q_auto,f_png/v1773048226/strawberry-robot-224_gna5hq.png';

const LATO_CDN_BASE = 'https://cdn.aflow.ai/fonts/lato';

/** Minimal @font-face set for body copy (400) and bold (700). Other weights synthesize. */
const PHOENIX_EMAIL_LATO_FONT_FACE = `@font-face{font-family:'Lato';font-style:normal;font-weight:400;font-display:swap;src:url('${LATO_CDN_BASE}/lato-regular.woff2') format('woff2');}
@font-face{font-family:'Lato';font-style:normal;font-weight:700;font-display:swap;src:url('${LATO_CDN_BASE}/lato-bold.woff2') format('woff2');}`;

export interface PhoenixDarkEmailDocumentOptions {
  /** Document <title> — should be plain text; HTML-escaped internally. */
  title: string;
  /** Raw HTML inside the main card body cell (padding + typography wrapper applied here). */
  cardBodyHtml: string;
}

function escapeHtmlText(raw: string): string {
  return raw
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Escape text for safe inclusion in HTML text nodes (paragraphs, headings in templates).
 */
export function escapeHtmlForEmailText(raw: string): string {
  return escapeHtmlText(raw);
}

/**
 * Escape a string for use in double-quoted HTML attributes (e.g. href).
 */
export function escapeHtmlForEmailAttribute(raw: string): string {
  return escapeHtmlText(raw);
}

const c = PHOENIX_EMAIL_DARK_COLORS;

/**
 * Full HTML document: logo row, card with `cardBodyHtml`, Aflow footer.
 */
export function buildPhoenixDarkEmailDocument(options: PhoenixDarkEmailDocumentOptions): string {
  const titleSafe = escapeHtmlText(options.title);
  const { cardBodyHtml } = options;
  const logoSrc = escapeHtmlForEmailAttribute(AFLOW_EMAIL_LOGO_IMAGE_URL);

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>${titleSafe}</title>
  <style>
    ${PHOENIX_EMAIL_LATO_FONT_FACE}
    body, table, td { font-family: ${PHOENIX_EMAIL_FONT_FAMILY}; }
    @media (prefers-color-scheme: dark) {
      .email-body { background-color: ${c.canvas} !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:${c.canvas};font-family:${PHOENIX_EMAIL_FONT_FAMILY};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${c.canvas};">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
          <tr>
            <td style="padding:0 0 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:10px;">
                    <img src="${logoSrc}" alt="aflow.ai" width="22" height="22" style="display:block;border:0;" />
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:17px;font-weight:600;color:${c.textSecondary};letter-spacing:0.01em;">aflow.ai</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:${c.raised};border:1px solid ${c.border};border-radius:12px;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="content" style="padding:32px 36px;color:${c.textPrimary};font-size:15px;line-height:1.7;">
                    ${cardBodyHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 4px 0;color:${c.textMuted};font-size:12px;line-height:1.5;">
              This is an automated notification from aflow.ai. Do not reply to this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
