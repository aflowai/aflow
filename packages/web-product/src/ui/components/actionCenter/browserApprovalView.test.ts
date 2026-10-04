/**
 * The approval card's browser variant: what it says of the site, the page,
 * the action, the value and the screenshot, rendered through the card itself.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActionCenterItem,
  BrowserWriteApprovalExtension,
} from '../../hooks/use-action-center-types.js';

vi.mock('@aflow/design-system', () => {
  const tag =
    (name: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement('div', { 'data-ds': name }, children);
  return {
    Badge: tag('badge'),
    Button: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
    Card: tag('card'),
    CardBody: tag('card-body'),
    Column: tag('column'),
    Row: tag('row'),
    Text: tag('text'),
  };
});

vi.mock('../../hooks/useApiQuery.js', () => ({
  useApiQuery: () => ({ data: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } }),
}));

const { WriteApprovalCard } = await import('./WriteApprovalCard.js');
const { browserApprovalView, screenshotSource } = await import('./browserApprovalView.js');

const EXTENSION: BrowserWriteApprovalExtension = {
  kind: 'write_approval',
  target: 'browser',
  profileId: 'default',
  pageOrigin: 'https://shop.example.com',
  pageTitle: 'Checkout',
  action: 'type',
  element: { ref: 'e3', role: 'textbox', name: 'Note' },
  value: {
    kind: 'text',
    length: 17,
    excerpt: 'leave at the door',
    truncated: false,
    submit: true,
  },
  askedBy: { kind: 'posture' },
  screenshotRef: 'redis:payload:shot-1',
  standsUntil: '2026-10-04T13:00:00.000Z',
};

function render(extension: BrowserWriteApprovalExtension): string {
  const item = {
    id: 'step:s1',
    title: 'Approve in the browser: type 17 characters into textbox “Note” on shop.example.com',
    allowedActions: ['approve', 'reject'],
  } as unknown as ActionCenterItem;
  return renderToStaticMarkup(
    createElement(WriteApprovalCard, {
      item,
      extension,
      onResolve: () => Promise.resolve(),
      resolveState: 'idle',
    }),
  );
}

describe('the approval card for a browser action', () => {
  it('shows the site, the page, what will be done to which element, the value and the page', () => {
    const html = render(EXTENSION);
    expect(html).toContain('shop.example.com');
    expect(html).toContain('Checkout');
    expect(html).toContain('Type 17 characters into textbox “Note” and press Enter.');
    expect(html).toContain('leave at the door');
    expect(html).toContain('browser profile default asks before every action');
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('Approve');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Request body');
  });

  it('shows a credential field by its length alone', () => {
    const view = browserApprovalView({
      ...EXTENSION,
      value: { kind: 'credential', length: 12, truncated: false, submit: false },
    });
    expect(view.value).toEqual({ label: 'A credential field: 12 characters, not shown.' });
  });

  it('says which rule asked, and that a long value is only its start', () => {
    const view = browserApprovalView({
      ...EXTENSION,
      askedBy: { kind: 'rule', rule: '*.example.com' },
      value: { kind: 'text', length: 900, excerpt: 'a long note', truncated: true },
    });
    expect(view.askedBy).toContain('the rule *.example.com');
    expect(view.value?.label).toBe('Text, 900 characters — the start of it:');
  });

  it('reads the truncated flag, not the lengths, to say a value is only its start', () => {
    // Ten graphemes of twenty UTF-16 units, the start of fifteen: comparing the excerpt's length
    // with the value's would read it as the whole.
    const start = '\u{1F600}'.repeat(10);
    expect(
      browserApprovalView({
        ...EXTENSION,
        value: { kind: 'text', length: 15, excerpt: start, truncated: true },
      }).value?.label,
    ).toBe('Text, 15 characters — the start of it:');
    expect(
      browserApprovalView({
        ...EXTENSION,
        value: { kind: 'options', length: 40, excerpt: 'Red, Green', truncated: true },
      }).value?.label,
    ).toBe('40 options — the start of the list:');
  });

  it('says until when the request stands', () => {
    expect(render(EXTENSION)).toContain('This request stands until ');
    expect(browserApprovalView(EXTENSION).standsUntil).toContain('2026');
  });

  it('names a click with nothing entered, and a page with no screenshot shows none', () => {
    const { value: _value, screenshotRef: _ref, ...clicked } = EXTENSION;
    const view = browserApprovalView({
      ...clicked,
      action: 'click',
      element: { ref: 'e6', role: 'button', name: 'Pay now' },
    });
    expect(view.doing).toBe('Click button “Pay now”.');
    expect(view.value).toBeUndefined();
    expect(
      render({ ...clicked, action: 'click', element: { ref: 'e6', role: 'button' } }),
    ).not.toContain('<img');
  });

  it('reads only an image a screenshot payload holds', () => {
    expect(screenshotSource({ data: 'AAAA', mimeType: 'image/jpeg' })).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    expect(screenshotSource({ data: 'AAAA', mimeType: 'text/html' })).toBeUndefined();
    expect(screenshotSource('not an image')).toBeUndefined();
  });
});
