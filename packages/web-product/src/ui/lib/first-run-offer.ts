import type { QuickStartOffer } from '@aflow/schemas';

/** Not now writes it. The old first-run modal wrote the same key, so its declines carry over. */
export const QUICK_START_OFFER_DECLINED_KEY = 'aflow:quick-start-offer-declined';

export interface FirstRunOfferInput {
  offer: QuickStartOffer | undefined;
  activeSpaceId: string | null | undefined;
  emptyChat: boolean;
  declined: boolean;
}

/**
 * Whether the first-run card shows in the empty chat (Plan 334 D1). The server
 * decides whether the offer applies and ends it once the space is used. The
 * open chat and this browser's decline decide the rest.
 */
export function shouldOfferQuickStarts({
  offer,
  activeSpaceId,
  emptyChat,
  declined,
}: FirstRunOfferInput): boolean {
  if (!offer?.applies || !offer.emptySpace) return false;
  if (offer.templates.length === 0) return false;
  if (!activeSpaceId || activeSpaceId !== offer.emptySpace.id) return false;
  return emptyChat && !declined;
}

/** "A", "A and B", "A, B and C". */
export function joinTemplateNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}
