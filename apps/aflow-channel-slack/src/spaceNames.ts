/**
 * The space's name in brackets, which opens every message the app posts for a
 * space. A channel speaks for a space, so the operator always reads which one
 * speaks: `[Trading Joe] The deploy waits on you.`
 *
 * A name is read through the API and kept for five minutes, so a renamed space
 * shows its new name soon and a thread of notes reads it once. A read that
 * fails keeps the last name read. A space whose name was never read shows its
 * id, which still names it.
 */
import type { AflowApi } from './aflowApi.js';
import { escapeMrkdwn } from './cards.js';
import type { SlackBlock } from './slack.js';

export const SPACE_NAME_TTL_MS = 5 * 60 * 1000;

export class SpaceNames {
  private readonly names = new Map<string, { name: string; readAt: number }>();

  constructor(
    private readonly api: Pick<AflowApi, 'spaceName'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** `[name] ` as mrkdwn, ready to open a message. */
  async prefix(spaceId: string, signal?: AbortSignal): Promise<string> {
    const kept = this.names.get(spaceId);
    let name = kept?.name;
    if (kept === undefined || this.now() - kept.readAt >= SPACE_NAME_TTL_MS) {
      const read = await this.api.spaceName(spaceId, signal).catch(() => undefined);
      if (read?.ok === true) {
        name = read.name;
        this.names.set(spaceId, { name, readAt: this.now() });
      }
    }
    return spacePrefix(name ?? spaceId);
  }
}

export function spacePrefix(name: string): string {
  return `[${escapeMrkdwn(name)}] `;
}

/**
 * `blocks` with `prefix` opening the first block that shows mrkdwn, because
 * Slack shows a message's blocks in place of its text.
 */
export function prefixedBlocks(prefix: string, blocks: readonly SlackBlock[]): SlackBlock[] {
  let done = false;
  return blocks.map((block) => {
    if (done) return block;
    const text = block['text'] as { type?: unknown; text?: unknown } | undefined;
    if (block['type'] === 'section' && text?.type === 'mrkdwn' && typeof text.text === 'string') {
      done = true;
      return { ...block, text: { ...text, text: `${prefix}${text.text}` } };
    }
    const elements = block['elements'] as Array<{ type?: unknown; text?: unknown }> | undefined;
    const first = elements?.[0];
    if (
      block['type'] === 'context' &&
      first?.type === 'mrkdwn' &&
      typeof first.text === 'string' &&
      elements !== undefined
    ) {
      done = true;
      return {
        ...block,
        elements: [{ ...first, text: `${prefix}${first.text}` }, ...elements.slice(1)],
      };
    }
    return block;
  });
}
