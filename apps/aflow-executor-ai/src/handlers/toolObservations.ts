import {
  ToolResultObservationSchema,
  type AiContentPart,
  type AiMessageV1,
  type AiToolResultEnvelopeV1,
  type ToolResultObservation,
} from '@aflow/schemas';

interface ObservedResult {
  partIndex: number;
  envelope: Omit<AiToolResultEnvelopeV1, 'observation'>;
  observation: ToolResultObservation;
}

/** What first followed a result of the same group and key — the newer look, or the end. */
interface Successor {
  role: ToolResultObservation['role'];
  operation: string;
}

function observedResultOf(message: AiMessageV1): ObservedResult | undefined {
  if (message.role !== 'tool') return undefined;
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.kind !== 'json') continue;
    const json = part.json as Record<string, unknown> | null;
    if (json?.['kind'] !== 'tool_result' || json['observation'] === undefined) continue;
    const observation = ToolResultObservationSchema.safeParse(json['observation']);
    if (!observation.success) return undefined;
    const { observation: _stamp, ...envelope } = json as unknown as AiToolResultEnvelopeV1;
    return { partIndex, envelope, observation: observation.data };
  }
  return undefined;
}

function supersededLine(
  observation: Extract<ToolResultObservation, { role: 'observes' }>,
  successor: Successor,
): string {
  return successor.role === 'ends'
    ? `${successor.operation} ended ${observation.key} after this result; its observation is not kept.`
    : `A later ${observation.group} result for ${observation.key} replaced this one's observation; ` +
        `${observation.currentStateOperation} returns the current state.`;
}

/**
 * The messages as the model is shown them: every tool result that observes a
 * group and key is shown in full when it is the newest result for that key,
 * and as its receipt and one line naming what superseded it when a later
 * result observed or ended the same key. The stamp itself is never shown.
 *
 * A pure function of the list, and the reduced form depends only on the first
 * result that followed — which never changes once it exists — so a result
 * changes form once and is identical on every turn after.
 */
export function renderToolObservations(messages: readonly AiMessageV1[]): AiMessageV1[] {
  const successors = new Map<string, Successor>();
  const rendered: AiMessageV1[] = new Array<AiMessageV1>(messages.length);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const observed = observedResultOf(message);
    if (observed === undefined) {
      rendered[index] = message;
      continue;
    }
    const { partIndex, envelope, observation } = observed;
    const slot = `${observation.group}\u0000${observation.key}`;
    const successor = successors.get(slot);
    if (observation.role === 'observes' && successor !== undefined) {
      const { images: _images, imagesWithheld: _withheld, ...receiptEnvelope } = envelope;
      rendered[index] = {
        ...message,
        parts: [
          {
            kind: 'json',
            json: {
              ...receiptEnvelope,
              summary: `${supersededLine(observation, successor)}\n${observation.receipt}`,
            },
          },
        ],
      };
    } else {
      rendered[index] = {
        ...message,
        parts: message.parts.map((part, i): AiContentPart =>
          i === partIndex ? { kind: 'json', json: envelope } : part,
        ),
      };
    }
    successors.set(slot, {
      role: observation.role,
      operation: envelope.operationId ?? envelope.toolName,
    });
  }
  return rendered;
}
