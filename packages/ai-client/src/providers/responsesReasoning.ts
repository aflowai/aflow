/**
 * Capture and replay of Responses API reasoning items.
 *
 * The items, including `encrypted_content`, are stored and sent back unchanged.
 * Only a provider that asks for this sees them; OpenAI's own path does not.
 */
import type OpenAI from 'openai';
import type { ChatMessage, ProviderReasoning } from '../types.js';

type ResponsesInputItem = OpenAI.Responses.ResponseInputItem;

/** Providers whose Responses reasoning items this adapter stores and sends back. */
export type ResponsesReasoningProvider = 'xai';

function isResponsesReasoningItem(block: unknown): block is ResponsesInputItem {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'reasoning'
  );
}

/**
 * Reasoning items already stored on an assistant turn, in their original order.
 * Returned only when the artifact belongs to the provider that asked to retain them.
 */
export function replayedReasoningItems(
  message: ChatMessage,
  provider: ResponsesReasoningProvider | undefined,
): ResponsesInputItem[] {
  if (provider === undefined || message.role !== 'assistant') return [];
  const artifact = message.providerReasoning;
  if (artifact?.provider !== provider) return [];
  return artifact.blocks.filter(isResponsesReasoningItem);
}

/** Reasoning output items from one Responses result, tagged for the next turn. */
export function captureResponsesReasoning(
  output: ReadonlyArray<{ type: string }>,
  provider: ResponsesReasoningProvider | undefined,
  model: string,
): ProviderReasoning | undefined {
  if (provider === undefined) return undefined;
  const blocks = output.filter((item) => item.type === 'reasoning');
  if (blocks.length === 0) return undefined;
  return { provider, model, blocks };
}
