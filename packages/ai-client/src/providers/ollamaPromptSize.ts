/**
 * How large a prompt is, in a runtime's tokens, without its tokenizer
 * (Plan 323 D5).
 *
 * Characters per token, measured against the runtime's own counts (§9 G1),
 * run from 1.6 (Chinese) through 2.8 (JSON) and 3.5–4.0 (code) to 4.8
 * (English and German). Dividing by the lowest gives a size no prompt
 * exceeds; dividing by the highest gives one every prompt reaches. The first
 * decides whether a prompt may be sent without counting it; the second is
 * how a response reveals that the runtime cut its prompt.
 */

/**
 * The smallest answer a prompt must leave room for. Prompt budgeting holds the
 * same reserve back (the executor's retention policy reads this constant), so
 * a prompt the budget let through is never refused here for want of room.
 */
export const MIN_ANSWER_TOKENS = 4096;

/** Below the lowest measured ratio, so no script or format is undercounted. */
const CHARS_PER_TOKEN_FLOOR = 1.5;
/** Above the highest measured ratio, so every prompt is at least this many tokens. */
const CHARS_PER_TOKEN_CEILING = 5;

interface SizedMessage {
  content: string;
  images?: string[];
  tool_calls?: unknown;
  tool_name?: string;
}

export interface PromptSizing {
  /** Tokens the prompt cannot exceed. */
  conservativeTokens: number;
  /** Tokens the prompt cannot fall below. */
  lowerBoundTokens: number;
  /**
   * The prompt carries something characters cannot size. Images are one: a
   * 1280×800 image costs 524 tokens on one model and 1,002 on another, and
   * a model that sizes images by resolution costs more for a larger one.
   */
  needsExactCount: boolean;
}

export function sizePrompt(
  messages: readonly SizedMessage[],
  tools?: readonly unknown[],
): PromptSizing {
  const texts: string[] = tools && tools.length > 0 ? [JSON.stringify(tools)] : [];
  let needsExactCount = false;
  for (const message of messages) {
    texts.push(message.content);
    if (message.tool_calls !== undefined) texts.push(JSON.stringify(message.tool_calls));
    if (message.tool_name !== undefined) texts.push(message.tool_name);
    if (message.images && message.images.length > 0) needsExactCount = true;
  }
  let chars = 0;
  let incompressibleChars = 0;
  for (const text of texts) {
    chars += text.length;
    incompressibleChars += collapseRuns(text).length;
  }
  return {
    conservativeTokens: Math.ceil(chars / CHARS_PER_TOKEN_FLOOR),
    lowerBoundTokens: Math.floor(incompressibleChars / CHARS_PER_TOKEN_CEILING),
    needsExactCount,
  };
}

/**
 * A run of one character — indentation, padding, a rule of dashes — can be a
 * single token however long it is, so the floor counts each run once.
 */
function collapseRuns(text: string): string {
  return text.replace(/(\s)\s+/g, '$1').replace(/(.)\1+/gs, '$1');
}
