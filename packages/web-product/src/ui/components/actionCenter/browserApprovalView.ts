import { browserApprovalActionPhrase } from '@aflow/schemas';

import type { BrowserWriteApprovalExtension } from '../../hooks/use-action-center-types.js';

export interface BrowserApprovalView {
  /** The site, by host. */
  readonly site: string;
  /** Where on the site: the path of the element's frame, without its query or fragment. */
  readonly path: string;
  readonly pageTitle: string;
  /** "Click button “Pay now”." */
  readonly doing: string;
  /** What would be entered, when anything would. */
  readonly value?: { readonly label: string; readonly text?: string };
  readonly askedBy: string;
  /** "This request stands until …" */
  readonly standsUntil: string;
}

function siteOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function characters(count: number): string {
  return `${String(count)} character${count === 1 ? '' : 's'}`;
}

function valueOf(extension: BrowserWriteApprovalExtension): BrowserApprovalView['value'] {
  const value = extension.value;
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'credential':
      return { label: `A credential field: ${characters(value.length)}, not shown.` };
    case 'text':
      return {
        label: value.truncated
          ? `Text, ${characters(value.length)} — the start of it:`
          : `Text, ${characters(value.length)}:`,
        ...(value.excerpt !== undefined ? { text: value.excerpt } : {}),
      };
    case 'options':
      return {
        label:
          (value.length === 1 ? 'Option' : `${String(value.length)} options`) +
          (value.truncated ? ' — the start of the list:' : ':'),
        ...(value.excerpt !== undefined ? { text: value.excerpt } : {}),
      };
    case 'key':
      return undefined;
  }
}

/** What the approval card shows for an action in the agent's browser. */
export function browserApprovalView(extension: BrowserWriteApprovalExtension): BrowserApprovalView {
  const phrase = browserApprovalActionPhrase(extension);
  const value = valueOf(extension);
  return {
    site: siteOf(extension.pageOrigin),
    path: extension.pagePath,
    pageTitle: extension.pageTitle,
    doing: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`,
    ...(value !== undefined ? { value } : {}),
    askedBy:
      extension.askedBy.kind === 'rule'
        ? `Asked because the rule ${extension.askedBy.rule} on browser profile ${extension.profileId} asks before actions there.`
        : `Asked because browser profile ${extension.profileId} asks before every action.`,
    standsUntil: `This request stands until ${new Date(extension.standsUntil).toLocaleString(
      undefined,
      {
        dateStyle: 'medium',
        timeStyle: 'short',
      },
    )}. Unanswered by then, it lapses and the agent's page may be closed.`,
  };
}

/** The image a screenshot payload holds, as the browser step stored it. */
export function screenshotSource(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { data, mimeType } = payload as { data?: unknown; mimeType?: unknown };
  if (typeof data !== 'string' || typeof mimeType !== 'string') return undefined;
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') return undefined;
  return `data:${mimeType};base64,${data}`;
}
