/**
 * An Action Center item as a Slack card (Plan 327 D3).
 *
 * `planCard` is the D3 table and the app's whole ceiling. It keys on the item's
 * origin as well as its kind, because the app's key is not an interactive
 * sign-in and some sources refuse every resolver that is not one: a plan
 * decision is a `human_input` item and a plan ask a `human_approval` one, and
 * both would carry dead buttons on a table keyed on kind alone. The route
 * would accept a `high` write approval from the key, so the tier rule holds
 * here and nowhere else until the server-side trust level exists (D5).
 *
 * A control also needs the action in the item's `allowedActions`, which the
 * API computes for the key's user. That narrows the table and never widens it.
 */
import type {
  ActionCenterAllowedAction,
  ActionCenterItem,
  ActionCenterResolution,
} from '@aflow/schemas';

import type { SlackBlock } from './slack.js';

export type CardRow = 'choices' | 'text_reply' | 'approval' | 'write_approval' | 'at_aflow';

export interface CardControl {
  /** The `action_id` Slack hands back on a tap. Unique within the card. */
  id: string;
  label: string;
  style?: 'primary' | 'danger';
  resolution: ActionCenterResolution;
  /** What the edited card says was decided. */
  decided: string;
}

export interface CardPlan {
  row: CardRow;
  /** Empty on a card that offers no button. */
  controls: CardControl[];
}

/** Slack's most buttons in one actions block. */
export const MAX_CARD_BUTTONS = 25;
/** Slack's longest button label. */
const MAX_BUTTON_LABEL = 75;
/** Slack's longest section text. */
const MAX_SECTION_TEXT = 3_000;

const AT_AFLOW: CardPlan = { row: 'at_aflow', controls: [] };

/** Keys that make a JSON schema more than one flat value. */
const STRUCTURE_KEYS = [
  'properties',
  'items',
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
  'additionalProperties',
  'patternProperties',
] as const;

function isFlat(schema: Record<string, unknown>): boolean {
  return STRUCTURE_KEYS.every((key) => schema[key] === undefined);
}

function label(text: string): string {
  return text.length <= MAX_BUTTON_LABEL ? text : `${text.slice(0, MAX_BUTTON_LABEL - 1)}…`;
}

function choice(index: number, value: string | number | boolean, shown: string): CardControl {
  return {
    id: `choice:${String(index)}`,
    label: label(shown),
    resolution: { kind: 'submit', payload: value },
    decided: `Answered “${escapeMrkdwn(shown)}”`,
  };
}

function approveDeny(item: ActionCenterItem): CardControl[] {
  return [
    {
      id: 'approve',
      label: label(item.uiHints?.approveLabel ?? 'Approve'),
      style: 'primary',
      resolution: { kind: 'approve' },
      decided: 'Approved',
    },
    {
      id: 'reject',
      label: label(item.uiHints?.rejectLabel ?? 'Deny'),
      style: 'danger',
      resolution: { kind: 'reject', reason: 'Denied from Slack.' },
      decided: 'Denied',
    },
  ];
}

function isPlainValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function inputPlan(item: ActionCenterItem): CardPlan {
  if (item.uiHints?.mode === 'form') return AT_AFLOW;
  const schema = item.resolutionSchema ?? {};
  if (!isFlat(schema)) return AT_AFLOW;
  const values: unknown = schema['enum'];
  if (Array.isArray(values)) {
    const plain = values.filter(isPlainValue);
    if (plain.length !== values.length || plain.length === 0 || plain.length > MAX_CARD_BUTTONS) {
      return AT_AFLOW;
    }
    return {
      row: 'choices',
      controls: plain.map((value, index) => choice(index, value, String(value))),
    };
  }
  if (schema['type'] === 'boolean') {
    return { row: 'choices', controls: [choice(0, true, 'Yes'), choice(1, false, 'No')] };
  }
  // No schema reads as text, as the web app's answer form reads it.
  if (schema['type'] === 'string' || schema['type'] === undefined) {
    return { row: 'text_reply', controls: [] };
  }
  return AT_AFLOW;
}

function tablePlan(item: ActionCenterItem): CardPlan {
  if (item.status !== 'open') return AT_AFLOW;
  const origin = item.origin.type;
  if (item.kind === 'human_input' && origin === 'step') return inputPlan(item);
  if (item.kind === 'human_approval' && origin === 'step') {
    return { row: 'approval', controls: approveDeny(item) };
  }
  if (
    item.kind === 'write_approval' &&
    (origin === 'step' || origin === 'workflow_task') &&
    item.extension?.kind === 'write_approval' &&
    item.extension.target === 'api' &&
    (item.extension.writeRiskTier === 'low' || item.extension.writeRiskTier === 'medium')
  ) {
    return { row: 'write_approval', controls: approveDeny(item) };
  }
  return AT_AFLOW;
}

function actionOf(resolution: ActionCenterResolution): ActionCenterAllowedAction {
  return resolution.kind === 'submit'
    ? 'submit'
    : resolution.kind === 'approve'
      ? 'approve'
      : 'reject';
}

/** What the card offers for `item`: the D3 table, narrowed by what the key may do. */
export function planCard(item: ActionCenterItem): CardPlan {
  const plan = tablePlan(item);
  const permitted = (action: ActionCenterAllowedAction): boolean =>
    item.allowedActions.includes(action);
  if (plan.row === 'text_reply') return permitted('submit') ? plan : AT_AFLOW;
  if (plan.controls.some((control) => !permitted(actionOf(control.resolution)))) return AT_AFLOW;
  return plan;
}

/** Slack's mrkdwn reads these three as markup. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Leaves room under Slack's 50 blocks for the item, its preview and the controls. */
const MAX_TEXT_SECTIONS = 40;

/**
 * Escapes `text` one character at a time into at most `count` pieces of at
 * most `room` characters each, and ends a cut text with an ellipsis. A piece
 * holds whole escapes, because one that ends inside `&amp;` shows the broken
 * entity.
 */
function escapedPieces(text: string, count: number, room: number): string[] {
  const pieces: string[] = [];
  let current = '';
  // How much of `current` fits with room left for the ellipsis of a cut text.
  let fitsWithEllipsis = 0;
  for (const char of text) {
    const escaped = escapeMrkdwn(char);
    if (current.length + escaped.length > room) {
      if (pieces.length === count - 1) {
        pieces.push(`${current.slice(0, fitsWithEllipsis)}…`);
        return pieces;
      }
      pieces.push(current);
      current = '';
      fitsWithEllipsis = 0;
    }
    current += escaped;
    if (current.length <= room - 1) fitsWithEllipsis = current.length;
  }
  if (current !== '') pieces.push(current);
  return pieces;
}

/** `text` escaped and cut to `room` characters on a whole escape. */
function escapedWithin(text: string, room: number): string {
  return escapedPieces(text, 1, room)[0] ?? '';
}

function sections(text: string): SlackBlock[] {
  return escapedPieces(text, MAX_TEXT_SECTIONS, MAX_SECTION_TEXT).map((section) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: section },
  }));
}

function context(text: string): SlackBlock {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

/** The preview Plan 253's gate computed: the call, its host, its tier and its redacted body. */
function previewBlocks(item: ActionCenterItem): SlackBlock[] {
  const extension = item.extension;
  if (extension?.kind !== 'write_approval' || extension.target !== 'api') return [];
  const endpoint = extension.operationLabel ?? extension.endpointName ?? extension.endpointId;
  const blocks: SlackBlock[] = [
    context(
      escapeMrkdwn(
        `${extension.method} ${extension.urlHost} · ${extension.apiId}/${extension.endpointId} · ` +
          `${endpoint} · tier ${extension.writeRiskTier}`,
      ),
    ),
  ];
  if (extension.bodyPreview !== undefined) {
    const body = extension.bodyPreview.replace(/```/g, '`​``');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`${escapedWithin(body, MAX_SECTION_TEXT - 6)}\`\`\``,
      },
    });
  }
  return blocks;
}

/**
 * The card without its controls: the agent's text, then what waits. Kept with
 * the card, so an edit after the decision shows the same message.
 */
export function cardHead(text: string, item: ActionCenterItem): SlackBlock[] {
  // A title holds 256 characters, so escaped it leaves the summary most of the section.
  const title = `*${escapeMrkdwn(item.title)}*\n`;
  const what = `${title}${escapedWithin(item.summary, MAX_SECTION_TEXT - title.length)}`;
  return [
    ...sections(text),
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: what } },
    ...previewBlocks(item),
  ];
}

export const REPLY_TO_ANSWER =
  'Reply in this message’s thread to answer. Your reply is sent as the answer.';

export function atAflowNote(title: string): string {
  return (
    `“${escapeMrkdwn(title)}” waits on you, and it needs you at Aflow. ` +
    'Open the Action Center there to decide it. It cannot be decided from Slack.'
  );
}

/** The blocks under the head while the card is open. */
export function openFoot(plan: CardPlan, title: string): SlackBlock[] {
  if (plan.row === 'text_reply') return [context(REPLY_TO_ANSWER)];
  if (plan.controls.length === 0) return [context(atAflowNote(title))];
  return [
    {
      type: 'actions',
      elements: plan.controls.map((control) => ({
        type: 'button',
        action_id: control.id,
        value: control.id,
        text: { type: 'plain_text', text: control.label },
        ...(control.style === undefined ? {} : { style: control.style }),
      })),
    },
  ];
}

/** The block that replaces the controls once the card has an outcome. */
export function outcomeFoot(note: string): SlackBlock[] {
  return [context(note)];
}
