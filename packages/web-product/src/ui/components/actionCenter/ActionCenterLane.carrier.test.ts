import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';

vi.mock('@aflow/design-system', () => {
  const tag = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Badge: tag,
    Card: tag,
    CardBody: tag,
    Column: tag,
    HitlResolution: tag,
    Row: tag,
    Text: tag,
  };
});
vi.mock('../providers.js', () => ({ useSpaceFromRoute: () => ({ slug: 'space' }) }));
vi.mock('../navigation-provider.js', () => ({ useNavigation: () => ({ push: vi.fn() }) }));
vi.mock('../cybernetic/ProposalCard.js', () => ({ ProposalCard: () => null }));
vi.mock('./OAuthConsentCard.js', () => ({ OAuthConsentCard: () => null }));
vi.mock('./WriteApprovalCard.js', () => ({ WriteApprovalCard: () => null }));
vi.mock('./BrowserHandoffCard.js', () => ({ BrowserHandoffCard: () => null }));
vi.mock('../setup-checklist.js', () => ({ SetupChecklist: () => null }));
vi.mock('./AssignControl.js', () => ({ AssignControl: () => null, AssigneeChip: () => null }));
vi.mock('../../hooks/use-space-people.js', () => ({ useSpacePeople: () => ({}) }));
vi.mock('../user-avatar.js', () => ({ useCurrentUser: () => null }));

const { ActionCenterLane } = await import('./ActionCenterLane.js');

it('keeps a carrier failure visible after the approved item disappears', () => {
  const carrierFailure = 'Carrier failed for closed node. Read its linked findings.';
  const state = { carrierFailures: [carrierFailure] } as UseActionCenterResult;
  const html = renderToStaticMarkup(
    createElement(ActionCenterLane, {
      title: 'Approvals',
      items: [],
      state,
      hideWhenEmpty: true,
    }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain(carrierFailure);
});
