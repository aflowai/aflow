'use client';

import { PageHeader, type PageHeaderProps } from '@aflow/design-system';
import { useRouter } from 'next/navigation';
import { SpaceSelector } from './space-selector.js';
import { useSpace } from './providers.js';
import { ActionIndicator } from './actionCenter/ActionIndicator';
import { spaceRoute } from '../lib/space-routes.js';

export interface AppPageHeaderProps extends PageHeaderProps {
  /**
   * Space-scoped chrome: the space breadcrumb prefix and the attention bell.
   * Off for tenant/account routes that exist outside a space.
   */
  showSpace?: boolean;
}

/**
 * The Action Center bell for the active space, with its count. A space page
 * whose header is not an `AppPageHeader` sets this in its own header.
 */
export function SpaceActionBell() {
  const { activeSpace } = useSpace();
  return activeSpace ? <ActionBell spaceId={activeSpace.id} spaceSlug={activeSpace.slug} /> : null;
}

function ActionBell({ spaceId, spaceSlug }: { spaceId: string; spaceSlug: string }) {
  const router = useRouter();
  // The bell leads to where items resolve: the Workbench.
  const bellHref = spaceRoute(spaceSlug, '/chat?workbench=1');
  return (
    <ActionIndicator
      spaceId={spaceId}
      onClick={() => {
        router.push(bellHref);
      }}
    />
  );
}

/**
 * App-level PageHeader: injects the active space as a clickable breadcrumb
 * prefix and the global Action Center bell into the actions slot. Drop-in
 * replacement for `PageHeader` from design-system.
 */
export function AppPageHeader({ showSpace = true, ...props }: AppPageHeaderProps) {
  const { activeSpace } = useSpace();
  const bell = showSpace && activeSpace ? <SpaceActionBell /> : null;

  const actions =
    bell || props.actions ? (
      <>
        {bell}
        {props.actions}
      </>
    ) : undefined;

  return (
    <PageHeader
      {...props}
      {...(actions !== undefined ? { actions } : {})}
      {...(showSpace
        ? { prefix: props.prefix ?? <SpaceSelector variant="inline" /> }
        : props.prefix !== undefined
          ? { prefix: props.prefix }
          : {})}
    />
  );
}
