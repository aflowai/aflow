/**
 * Rendering a tool message whose content carries images.
 *
 * By the time a request reaches an adapter the client has replaced every
 * image reference with an image or with text, so only `text` and `image`
 * parts remain. Anthropic takes images inside a tool result; the other
 * adapters send the tool result as text and the images in a user message
 * after the tool results.
 */
import { AIClientError } from '../errors.js';
import type { AIProvider, ChatMessage, ContentPart } from '../types.js';

type ToolMessage = Extract<ChatMessage, { role: 'tool' }>;

const IMAGE_FOLLOWS_TEXT = '[The image is in the user message that follows the tool results.]';

/** The tool message's parts, refusing a reference the client should have resolved. */
export function toolResultParts(message: ToolMessage, provider: AIProvider): ContentPart[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return message.content.map((part) => {
    if (part.type === 'image_ref') {
      throw new AIClientError(
        'A tool image reached the provider adapter unresolved.',
        'invalid_request',
        provider,
        false,
      );
    }
    return part;
  });
}

/** The tool message as text, each image named by where it is sent instead. */
export function toolResultText(message: ToolMessage, provider: AIProvider): string {
  if (typeof message.content === 'string') return message.content;
  return toolResultParts(message, provider)
    .map((part) => (part.type === 'text' ? part.text : IMAGE_FOLLOWS_TEXT))
    .join('\n');
}

/**
 * For an API whose tool result is text only: each run of tool messages keeps
 * its place as text, and one user message after the run carries the images,
 * each group labelled with the tool call it came from. The user message goes
 * after the whole run because a tool result separated from its assistant turn
 * by another message breaks the pairing these APIs require. Returns the same
 * array when no tool message carries an image.
 */
export function moveToolImagesToUserMessages(
  messages: ChatMessage[],
  provider: AIProvider,
): ChatMessage[] {
  const hasImage = messages.some(
    (m) =>
      m.role === 'tool' &&
      typeof m.content !== 'string' &&
      m.content.some((part) => part.type !== 'text'),
  );
  if (!hasImage) return messages;

  const out: ChatMessage[] = [];
  let pending: ContentPart[] = [];
  const flush = (): void => {
    if (pending.length > 0) out.push({ role: 'user', content: pending });
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== 'tool') {
      flush();
      out.push(message);
      continue;
    }
    const parts = toolResultParts(message, provider);
    const images = parts.filter((part) => part.type === 'image');
    out.push({ ...message, content: toolResultText(message, provider) });
    if (images.length > 0) {
      const label = message.name ? `${message.toolCallId} (${message.name})` : message.toolCallId;
      pending.push({ type: 'text', text: `Output of tool call ${label}:` }, ...images);
    }
  }
  flush();
  return out;
}
