import { describe, expect, it } from 'vitest';
import type { QuickStartOffer } from '@aflow/schemas';
import {
  joinTemplateNames,
  shouldOfferQuickStarts,
  type FirstRunOfferInput,
} from './first-run-offer.js';

const EMPTY_SPACE_ID = '00000000-0000-4000-8000-000000000001';

const OFFER = {
  applies: true,
  emptySpace: { id: EMPTY_SPACE_ID, slug: 'personal', name: 'Personal' },
  templates: [
    {
      catalogId: 'aflow.space.code-review-local',
      version: 1,
      name: 'Code Review on This Computer',
      tagline: 'Review a local branch.',
      spaceName: 'Code Review',
    },
  ],
} as QuickStartOffer;

const SHOWS: FirstRunOfferInput = {
  offer: OFFER,
  activeSpaceId: EMPTY_SPACE_ID,
  emptyChat: true,
  declined: false,
};

describe('shouldOfferQuickStarts', () => {
  it('shows in the empty chat of the empty first space', () => {
    expect(shouldOfferQuickStarts(SHOWS)).toBe(true);
  });

  it('does not show when the offer does not apply', () => {
    expect(shouldOfferQuickStarts({ ...SHOWS, offer: { ...OFFER, applies: false } })).toBe(false);
  });

  it('does not show before the offer has loaded', () => {
    expect(shouldOfferQuickStarts({ ...SHOWS, offer: undefined })).toBe(false);
  });

  it('does not show in another space', () => {
    expect(
      shouldOfferQuickStarts({ ...SHOWS, activeSpaceId: '00000000-0000-4000-8000-000000000002' }),
    ).toBe(false);
    expect(shouldOfferQuickStarts({ ...SHOWS, activeSpaceId: null })).toBe(false);
  });

  it('does not show over a conversation', () => {
    expect(shouldOfferQuickStarts({ ...SHOWS, emptyChat: false })).toBe(false);
  });

  it('does not show once this browser has declined it', () => {
    expect(shouldOfferQuickStarts({ ...SHOWS, declined: true })).toBe(false);
  });

  it('does not show with no templates on the shelf', () => {
    expect(shouldOfferQuickStarts({ ...SHOWS, offer: { ...OFFER, templates: [] } })).toBe(false);
  });
});

describe('joinTemplateNames', () => {
  it('joins the names with "and"', () => {
    expect(joinTemplateNames(['A'])).toBe('A');
    expect(joinTemplateNames(['A', 'B'])).toBe('A and B');
    expect(joinTemplateNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});
