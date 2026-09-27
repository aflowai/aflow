import type { Content } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Neutral opening user turn prepended by the Gemini and Anthropic adapters when
 * a windowed history would otherwise open on an assistant/model turn. Both
 * providers require conversations to open with a user turn; Gemini additionally
 * rejects a functionCall turn that does not immediately follow a user or
 * functionResponse turn.
 */
export const TRUNCATED_HISTORY_USER_BRIDGE_TEXT = '[Earlier conversation history truncated]';

export interface WireCheckResult {
  ok: boolean;
  issues: string[];
}

function geminiPartCounts(content: Content): { fc: number; fr: number; total: number } {
  const parts = content.parts ?? [];
  let fc = 0;
  let fr = 0;
  for (const part of parts) {
    if ('functionCall' in part && part.functionCall) fc++;
    if ('functionResponse' in part && part.functionResponse) fr++;
  }
  return { fc, fr, total: parts.length };
}

/**
 * Gemini `contents` wire rules:
 *  1. The first content must be user-role.
 *  2. Roles must not repeat consecutively (the adapter merges/bridges).
 *  3. A functionCall turn must be a model turn and must immediately follow a
 *     user turn (plain or functionResponse).
 *  4. A functionCall turn followed by anything must be followed by a
 *     functionResponse turn carrying exactly as many functionResponse parts as
 *     there were functionCall parts.
 *  5. functionResponse parts live in user turns, in isolation (never mixed with
 *     other part kinds), immediately after their functionCall turn.
 */
export function checkGeminiContentsWireValidity(contents: Content[]): WireCheckResult {
  const issues: string[] = [];
  if (contents.length === 0) {
    issues.push('contents is empty');
    return { ok: false, issues };
  }
  if (contents[0]?.role !== 'user') {
    issues.push(`first content must be user-role, got "${String(contents[0]?.role)}"`);
  }
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i]!;
    const prev = contents[i - 1];
    const next = contents[i + 1];
    const { fc, fr, total } = geminiPartCounts(content);

    if (total === 0) issues.push(`#${i} (${String(content.role)}): empty parts`);
    if (prev && prev.role === content.role) {
      issues.push(`#${i}: consecutive same-role contents ("${String(content.role)}")`);
    }

    if (fc > 0) {
      if (content.role !== 'model') {
        issues.push(`#${i}: functionCall part in ${String(content.role)} turn`);
      }
      if (!prev) {
        issues.push(
          `#${i}: functionCall turn is the first content — it must immediately follow a user turn or a function response turn`,
        );
      } else if (prev.role !== 'user') {
        issues.push(`#${i}: functionCall turn follows a ${String(prev.role)} turn`);
      }
      if (next) {
        const nextCounts = geminiPartCounts(next);
        if (nextCounts.fr === 0) {
          issues.push(
            `#${i}: functionCall turn not immediately followed by a function response turn`,
          );
        } else if (nextCounts.fr !== fc) {
          issues.push(
            `#${i}: ${String(fc)} functionCall part(s) but ${String(nextCounts.fr)} functionResponse part(s) in the next turn`,
          );
        }
      }
    }

    if (fr > 0) {
      if (content.role !== 'user') {
        issues.push(`#${i}: functionResponse part in ${String(content.role)} turn`);
      }
      if (fr !== total) {
        issues.push(`#${i}: functionResponse parts mixed with other part kinds`);
      }
      const prevFc = prev ? geminiPartCounts(prev).fc : 0;
      if (prev?.role !== 'model' || prevFc === 0) {
        issues.push(
          `#${i}: function response turn does not immediately follow a function call turn`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

interface AnthropicBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
}

function anthropicBlocks(message: Anthropic.MessageParam): AnthropicBlock[] {
  return Array.isArray(message.content) ? (message.content as AnthropicBlock[]) : [];
}

function multisetDiff(
  expected: string[],
  actual: string[],
): { missing: string[]; extra: string[] } {
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);
  const extra: string[] = [];
  for (const id of actual) {
    const remaining = counts.get(id) ?? 0;
    if (remaining <= 0) extra.push(id);
    else counts.set(id, remaining - 1);
  }
  const missing: string[] = [];
  for (const [id, remaining] of counts) for (let k = 0; k < remaining; k++) missing.push(id);
  return { missing, extra };
}

/**
 * Anthropic `messages` wire rules:
 *  1. The first message must use the user role.
 *  2. An assistant message with tool_use blocks must be immediately followed by
 *     a user message whose tool_result blocks carry exactly those ids.
 *  3. tool_result blocks appear only in user messages, only immediately after
 *     the assistant message owning their tool_use ids.
 */
export function checkAnthropicMessagesWireValidity(
  messages: Anthropic.MessageParam[],
): WireCheckResult {
  const issues: string[] = [];
  if (messages.length === 0) {
    issues.push('messages is empty');
    return { ok: false, issues };
  }
  if (messages[0]?.role !== 'user') {
    issues.push(`first message must use the "user" role, got "${String(messages[0]?.role)}"`);
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const blocks = anthropicBlocks(message);

    if (message.role === 'assistant') {
      const toolUseIds = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.id ?? '(missing id)');
      if (toolUseIds.length === 0) continue;
      const next = messages[i + 1];
      const nextResultIds = next
        ? anthropicBlocks(next)
            .filter((b) => b.type === 'tool_result')
            .map((b) => b.tool_use_id ?? '(missing id)')
        : [];
      if (next?.role !== 'user' || nextResultIds.length === 0) {
        issues.push(
          `#${i}: tool_use not immediately followed by a user message with tool_result blocks`,
        );
        continue;
      }
      const { missing, extra } = multisetDiff(toolUseIds, nextResultIds);
      if (missing.length > 0)
        issues.push(`#${i}: missing tool_result for id(s) ${missing.join(', ')}`);
      if (extra.length > 0) issues.push(`#${i}: unexpected tool_result id(s) ${extra.join(', ')}`);
    }

    if (message.role === 'user') {
      const resultBlocks = blocks.filter((b) => b.type === 'tool_result');
      if (resultBlocks.length === 0) continue;
      const prev = messages[i - 1];
      const prevToolUse =
        prev?.role === 'assistant'
          ? anthropicBlocks(prev).filter((b) => b.type === 'tool_use')
          : [];
      if (prevToolUse.length === 0) {
        issues.push(
          `#${i}: tool_result block(s) without an immediately preceding assistant tool_use`,
        );
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
