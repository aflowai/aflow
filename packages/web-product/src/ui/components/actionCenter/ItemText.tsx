'use client';

import type { ReactNode } from 'react';
import type { ActionCenterItem } from '../../hooks/use-action-center-types.js';
import { InlineMarkdown, MarkdownRenderer } from '../markdown-renderer.js';

/**
 * Whether an item carries its text as markdown: a plan step raises its item
 * from the node, whose title and note are markdown (Plan 338). Other sources
 * write plain text, which markdown would misread — an underscore in an
 * operation id is not emphasis.
 */
export function itemTextIsMarkdown(item: Pick<ActionCenterItem, 'origin'>): boolean {
  return item.origin.type === 'plan_ask' || item.origin.type === 'plan_decision';
}

/** An item's title as a line of text shows it: markdown where the item carries markdown. */
export function ItemTitleText({
  item,
}: {
  item: Pick<ActionCenterItem, 'origin' | 'title'>;
}): ReactNode {
  return itemTextIsMarkdown(item) ? <InlineMarkdown content={item.title} /> : item.title;
}

/**
 * Whether an item's summary is markdown. An agent's approval request writes its
 * description as markdown. A gate raises the same operation with platform text,
 * which stays plain.
 */
export function itemSummaryIsMarkdown(
  item: Pick<ActionCenterItem, 'origin' | 'gateContext'>,
): boolean {
  return (
    itemTextIsMarkdown(item) ||
    (item.origin.type === 'step' &&
      item.origin.operationId === 'user.interaction.approve' &&
      item.gateContext === undefined)
  );
}

/** An item's summary as a block; undefined where the item carries plain text, which the card renders itself. */
export function itemSummaryMarkdown(
  item: Pick<ActionCenterItem, 'origin' | 'summary' | 'gateContext'>,
): ReactNode | undefined {
  return itemSummaryIsMarkdown(item) ? (
    <MarkdownRenderer content={item.summary} style={{ fontSize: 'var(--font-size-sm)' }} />
  ) : undefined;
}
