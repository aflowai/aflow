import type { AiMessageV1 } from './aiPrompt.js';

/**
 * Conservative chars-per-token heuristic (slightly more generous than 4,
 * accounts for code/JSON having more tokens per character than prose).
 *
 * Shared rather than per-app on purpose: the tool surface is estimated by the
 * AI executor and the same figures are quoted by operator-facing surfaces. Two
 * copies of the constant would disagree by ~14% about the same tools, which is
 * indistinguishable from a real change to anyone reading the number.
 */
export const ESTIMATED_CHARS_PER_TOKEN = 3.5;

/** Rough pixels per token for an image a model sees, and the most one image is counted at. */
const PIXELS_PER_IMAGE_TOKEN = 750;
const IMAGE_TOKENS_CEILING = 1600;

/** Estimate tokens from a string. */
export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

/**
 * Estimate tokens from an AiMessageV1.
 * Accounts for text parts, JSON parts, and tool calls.
 */
export function estimateMessageTokens(msg: AiMessageV1): number {
  let chars = 0;
  // Message role overhead (~4 tokens)
  chars += 15;
  // Content parts
  if (msg.parts) {
    for (const part of msg.parts) {
      if (part.kind === 'text') {
        chars += part.text.length;
      } else if (part.kind === 'json') {
        chars += JSON.stringify(part.json).length;
      } else if (part.kind === 'ref') {
        // Ref parts include a summary and/or the ref string itself
        chars += (part.summary ?? '').length + (part.ref ?? '').length;
      } else {
        // Whether the model sees the pixels is decided later, per model, so
        // the larger of the two renderings is counted.
        const imageTokens = Math.min(
          IMAGE_TOKENS_CEILING,
          Math.ceil((part.width * part.height) / PIXELS_PER_IMAGE_TOKEN),
        );
        chars += Math.ceil(imageTokens * ESTIMATED_CHARS_PER_TOKEN);
      }
    }
  }
  // Tool calls (assistant messages)
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      chars += (tc.name ?? '').length;
      chars +=
        typeof tc.argumentsJson === 'string'
          ? tc.argumentsJson.length
          : JSON.stringify(tc.argumentsJson).length;
    }
  }
  // Tool result metadata (tool messages)
  if (msg.toolCallId) chars += msg.toolCallId.length;
  if (msg.name) chars += msg.name.length;

  // Provider-native reasoning retained for tool-use continuity (Plan 259) — these
  // blocks (Anthropic thinking text + signatures, Fireworks reasoning_content) are
  // replayed on the wire, so they count toward the request size.
  if (msg.providerReasoning) {
    chars += JSON.stringify(msg.providerReasoning.blocks).length;
  }

  return Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}
