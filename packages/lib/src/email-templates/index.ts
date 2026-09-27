/**
 * Transactional / branded HTML email templates (inline CSS, shared across server + executors).
 */

export {
  AFLOW_EMAIL_LOGO_IMAGE_URL,
  buildPhoenixDarkEmailDocument,
  escapeHtmlForEmailAttribute,
  escapeHtmlForEmailText,
  PHOENIX_EMAIL_DARK_COLORS,
  PHOENIX_EMAIL_FONT_FAMILY,
  type PhoenixDarkEmailDocumentOptions,
  type PhoenixEmailDarkColors,
} from './phoenix-dark.js';

import {
  buildPhoenixDarkEmailDocument,
  type PhoenixDarkEmailDocumentOptions,
} from './phoenix-dark.js';

/** Known template ids — extend this map when adding layouts. */
export type TransactionalEmailTemplateId = 'phoenix-dark';

export type BuildTransactionalEmailOptions = {
  template: TransactionalEmailTemplateId;
} & PhoenixDarkEmailDocumentOptions;

const transactionalEmailBuilders: Record<
  TransactionalEmailTemplateId,
  (opts: PhoenixDarkEmailDocumentOptions) => string
> = {
  'phoenix-dark': buildPhoenixDarkEmailDocument,
};

/**
 * Dispatch to a registered transactional email layout.
 * Prefer this at call sites when you want an explicit template id for logging or future A/B layouts.
 */
export function buildTransactionalEmail(options: BuildTransactionalEmailOptions): string {
  const { template, title, cardBodyHtml } = options;
  return transactionalEmailBuilders[template]({ title, cardBodyHtml });
}
