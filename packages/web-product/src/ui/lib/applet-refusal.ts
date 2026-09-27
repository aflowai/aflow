/**
 * The gateway's account of a refusal, shaped for the view.
 *
 * Every guard rejection and every failed test op carries a hand-written
 * `message`, and it is the only thing the room can be told about why a change
 * did not land — a refusal that arrives without it reads as the platform
 * saying no for no reason.
 */
import {
  APPLET_REFUSAL_MESSAGE_MAX_LENGTH,
  PhoenixAppletRefusalReasonSchema,
  type PhoenixAppletActionResultMessage,
} from '@aflow/schemas';

export type AppletRefusalDetail = Pick<
  PhoenixAppletActionResultMessage,
  'message' | 'reason' | 'validation' | 'availableActions'
>;

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

export function readRefusalDetail(body: unknown): AppletRefusalDetail {
  if (typeof body !== 'object' || body === null) return {};
  const fields = body as Record<string, unknown>;
  const message = fields['message'];
  const reason = fields['reason'];
  const validation = stringArray(fields['validation']);
  const availableActions = stringArray(fields['availableActions']);
  return {
    ...(typeof message === 'string' && message.length > 0
      ? { message: message.slice(0, APPLET_REFUSAL_MESSAGE_MAX_LENGTH) }
      : {}),
    ...(typeof reason === 'string' && PhoenixAppletRefusalReasonSchema.safeParse(reason).success
      ? { reason }
      : {}),
    ...(validation !== undefined ? { validation } : {}),
    ...(availableActions !== undefined ? { availableActions } : {}),
  };
}
