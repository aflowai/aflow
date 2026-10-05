/**
 * What an approver is shown of a page's address: the path of an http(s)
 * address with anything that may be a credential hidden and no query or
 * fragment, and any other address by its scheme alone.
 */
import { describe, expect, it } from 'vitest';

import {
  BROWSER_APPROVAL_HIDDEN_SEGMENT,
  BROWSER_APPROVAL_SEGMENT_MAX_UNITS,
  browserApprovalShownPath,
} from '../browserApprovalPath.js';
import { BROWSER_APPROVAL_PATH_MAX_UNITS } from '../requestedInput.js';

const HIDDEN = BROWSER_APPROVAL_HIDDEN_SEGMENT;
const SHOP = 'https://shop.example.com';

describe('browserApprovalShownPath', () => {
  it('shows a path of words and numbers as it is, without its query or fragment', () => {
    expect(browserApprovalShownPath(`${SHOP}/orders/4417/checkout?step=2#total`)).toBe(
      '/orders/4417/checkout',
    );
    expect(browserApprovalShownPath(`${SHOP}/blog/2026-10-05/how-to-pay-by-card`)).toBe(
      '/blog/2026-10-05/how-to-pay-by-card',
    );
    expect(browserApprovalShownPath('http://localhost:3001/')).toBe('/');
  });

  it('hides a hex identifier, with or without dashes', () => {
    const hex = 'b4d6'.repeat(8);
    expect(browserApprovalShownPath(`${SHOP}/orders/${hex}/pay`)).toBe(`/orders/${HIDDEN}/pay`);
    const dashed = ['a1b2c3d4', 'e5f6', '4a7b', '8c9d', 'e0f1a2b3c4d5'].join('-');
    expect(browserApprovalShownPath(`${SHOP}/share/${dashed}`)).toBe(`/share/${HIDDEN}`);
  });

  it('hides a run that mixes letters with digits or cases, as base64 does', () => {
    const token = ['Qm9va', '2luZ1', 'JlZmVy', 'ZW5jZQ'].join('');
    expect(browserApprovalShownPath(`${SHOP}/reset/${token}`)).toBe(`/reset/${HIDDEN}`);
    const lettersOnly = 'kQzXwPvRtLmNbHyJ';
    expect(browserApprovalShownPath(`${SHOP}/s/${lettersOnly}/view`)).toBe(`/s/${HIDDEN}/view`);
  });

  it('hides any segment longer than the bound, and only that segment', () => {
    const long = 'word-'.repeat(BROWSER_APPROVAL_SEGMENT_MAX_UNITS / 4);
    expect(long.length).toBeGreaterThan(BROWSER_APPROVAL_SEGMENT_MAX_UNITS);
    expect(browserApprovalShownPath(`${SHOP}/notes/${long}/edit`)).toBe(`/notes/${HIDDEN}/edit`);
    const atBound = 'order-notes-'.repeat(4);
    expect(atBound).toHaveLength(BROWSER_APPROVAL_SEGMENT_MAX_UNITS);
    expect(browserApprovalShownPath(`${SHOP}/${atBound}`)).toBe(`/${atBound}`);
  });

  it('shows an address of any other scheme by its scheme alone', () => {
    const content = encodeURIComponent('<p>order notes</p>');
    expect(browserApprovalShownPath(`data:text/html,${content}`)).toBe('data:');
    expect(browserApprovalShownPath(`blob:${SHOP}/${'5e7a'.repeat(8)}`)).toBe('blob:');
    expect(browserApprovalShownPath('about:blank')).toBe('about:');
    expect(browserApprovalShownPath('file:///Users/someone/orders.html')).toBe('file:');
  });

  it('shows nothing of an address it cannot read, and never more than the schema holds', () => {
    expect(browserApprovalShownPath('not an address')).toBe('');
    const many = '/a'.repeat(BROWSER_APPROVAL_PATH_MAX_UNITS);
    expect(browserApprovalShownPath(`${SHOP}${many}`)).toHaveLength(
      BROWSER_APPROVAL_PATH_MAX_UNITS,
    );
  });
});
