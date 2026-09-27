/**
 * Content rendering pipeline for email.
 *
 * Markdown → HTML (via marked) → sanitized HTML (via sanitize-html) → plain text (via html-to-text).
 * Raw HTML → sanitized HTML → plain text.
 *
 * Branded shell: `@aflow/lib` transactional template `phoenix-dark` (shared with server invite email).
 */
import { buildTransactionalEmail, PHOENIX_EMAIL_DARK_COLORS as colors } from '@aflow/lib';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { convert as htmlToText } from 'html-to-text';

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * Render email content from Markdown or HTML input.
 */
export async function renderEmailContent(
  content: string,
  format: 'markdown' | 'html',
): Promise<RenderedEmail> {
  let rawHtml: string;

  if (format === 'markdown') {
    rawHtml = await marked.parse(content, { async: true, gfm: true, breaks: true });
  } else {
    rawHtml = content;
  }

  const sanitized = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'br',
      'hr',
      'span',
      'div',
      'del',
      'ins',
      'sup',
      'sub',
    ]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height', 'style'],
      a: ['href', 'title', 'target', 'rel'],
      span: ['style'],
      td: ['style', 'align', 'valign'],
      th: ['style', 'align', 'valign'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
  });

  const cardBodyHtml = `<!--[if mso]><table role="presentation" width="100%"><tr><td><![endif]-->
${styleContent(sanitized)}
<!--[if mso]></td></tr></table><![endif]-->`;

  const html = buildTransactionalEmail({
    template: 'phoenix-dark',
    title: 'Notification from aflow.ai',
    cardBodyHtml,
  });

  const text = htmlToText(sanitized, {
    wordwrap: 80,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  });

  return { html, text };
}

/**
 * Apply inline styles to content HTML elements for dark theme email rendering.
 * Email clients strip <style> blocks, so everything must be inline.
 */
function styleContent(html: string): string {
  return (
    html
      // Headings
      .replace(
        /<h1(?=[>\s])/g,
        `<h1 style="margin:0 0 16px; font-size:22px; font-weight:600; color:${colors.textStrong}; line-height:1.3; letter-spacing:-0.02em;"`,
      )
      .replace(
        /<h2(?=[>\s])/g,
        `<h2 style="margin:24px 0 12px; font-size:18px; font-weight:600; color:${colors.textStrong}; line-height:1.3; letter-spacing:-0.01em;"`,
      )
      .replace(
        /<h3(?=[>\s])/g,
        `<h3 style="margin:20px 0 8px; font-size:15px; font-weight:600; color:${colors.textStrong}; line-height:1.4;"`,
      )
      .replace(
        /<h4(?=[>\s])/g,
        `<h4 style="margin:16px 0 8px; font-size:14px; font-weight:600; color:${colors.textSecondary}; text-transform:uppercase; letter-spacing:0.05em; line-height:1.4;"`,
      )
      // Paragraphs
      .replace(
        /<p(?=[>\s])/g,
        `<p style="margin:0 0 14px; color:${colors.textPrimary}; line-height:1.7;"`,
      )
      // Links
      .replace(/<a /g, `<a style="color:${colors.link}; text-decoration:none;" `)
      // Lists
      .replace(
        /<ul(?=[>\s])/g,
        `<ul style="margin:0 0 14px; padding-left:20px; color:${colors.textPrimary};"`,
      )
      .replace(
        /<ol(?=[>\s])/g,
        `<ol style="margin:0 0 14px; padding-left:20px; color:${colors.textPrimary};"`,
      )
      .replace(
        /<li(?=[>\s])/g,
        `<li style="margin:0 0 6px; line-height:1.6; color:${colors.textPrimary};"`,
      )
      // Blockquotes
      .replace(
        /<blockquote(?=[>\s])/g,
        `<blockquote style="margin:16px 0; padding:12px 20px; border-left:3px solid ${colors.accent}; background-color:${colors.accentBg}; border-radius:0 8px 8px 0; color:${colors.textSecondary};"`,
      )
      // Code
      .replace(
        /<code(?=[>\s])/g,
        `<code style="font-family:'SF Mono',Monaco,Consolas,monospace; font-size:13px; padding:2px 6px; background-color:${colors.codeBackground}; border:1px solid ${colors.border}; border-radius:4px; color:${colors.accent};"`,
      )
      .replace(
        /<pre(?=[>\s])/g,
        `<pre style="margin:16px 0; padding:16px; background-color:${colors.codeBackground}; border:1px solid ${colors.border}; border-radius:8px; overflow-x:auto; font-size:13px; line-height:1.5; color:${colors.textPrimary};"`,
      )
      // Horizontal rules
      .replace(
        /<hr\s*\/?>/g,
        `<hr style="border:none; border-top:1px solid ${colors.border}; margin:24px 0;" />`,
      )
      // Tables
      .replace(
        /<table(?=[>\s])/g,
        `<table style="width:100%; border-collapse:collapse; margin:16px 0; font-size:14px;"`,
      )
      .replace(
        /<th(?=[>\s])/g,
        `<th style="text-align:left; padding:8px 12px; border-bottom:2px solid ${colors.border}; color:${colors.textSecondary}; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.05em;"`,
      )
      .replace(
        /<td(?=[>\s])/g,
        `<td style="padding:8px 12px; border-bottom:1px solid ${colors.borderSubtle}; color:${colors.textPrimary};"`,
      )
      // Strong / emphasis
      .replace(/<strong(?=[>\s])/g, `<strong style="font-weight:600; color:${colors.textStrong};"`)
      .replace(/<em(?=[>\s])/g, `<em style="color:${colors.textSecondary};"`)
      // Images
      .replace(
        /<img /g,
        `<img style="max-width:100%; height:auto; border-radius:8px; margin:8px 0;" `,
      )
  );
}
