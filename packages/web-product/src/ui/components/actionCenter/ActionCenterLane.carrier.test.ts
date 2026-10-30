import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { UseActionCenterResult } from '../../hooks/use-action-center.js';

const dismiss = vi.hoisted(() => ({ action: undefined as (() => void) | undefined }));
vi.mock('@aflow/design-system', () => {
  const tag = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Badge: tag,
    Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
      dismiss.action = onClick;
      return createElement('button', null, children);
    },
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

const { WorkbenchNeedsAttention } = await import('../workbench/WorkbenchNeedsAttention.js');
vi.mock('../workbench/WorkbenchSection.js', () => ({
  WorkbenchSection: ({ children }: { children: ReactNode }) =>
    createElement('section', null, children),
}));

it('keeps a carrier failure visible after the approved item disappears', () => {
  const carrierFailure = 'Carrier failed for closed node. Read its linked findings.';
  const state = {
    carrierFailures: [carrierFailure],
    lanes: { connections: [], approvals: [], inputs: [] },
    clearCarrierFailures: vi.fn(),
  } as unknown as UseActionCenterResult;
  const html = renderToStaticMarkup(
    createElement(WorkbenchNeedsAttention, { state, spaceId: 'space' }),
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain(carrierFailure);
  expect(html).toContain('Dismiss');
  dismiss.action?.();
  expect(state.clearCarrierFailures).toHaveBeenCalledOnce();
});
