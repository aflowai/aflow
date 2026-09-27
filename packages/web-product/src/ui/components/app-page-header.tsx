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
  /** Suppress the global bell (the chat page carries its own affordances). */
  showActionBell?: boolean;
}

/**
 * App-level PageHeader: injects the active space as a clickable breadcrumb
 * prefix and the global Action Center bell into the actions slot. Drop-in
 * replacement for `PageHeader` from design-system.
 */
export function AppPageHeader({
  showSpace = true,
  showActionBell = true,
  ...props
}: AppPageHeaderProps) {
  const { activeSpace } = useSpace();
  const router = useRouter();

  // The bell leads to where items resolve: the Workbench.
  const bellHref = activeSpace ? spaceRoute(activeSpace.slug, '/chat?workbench=1') : null;

  const bell =
    showSpace && showActionBell && activeSpace && bellHref ? (
      <ActionIndicator
        spaceId={activeSpace.id}
        onClick={() => {
          router.push(bellHref);
        }}
      />
    ) : null;

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
