'use client';

import { type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useSpace } from './providers.js';
import { CyberneticProvider } from './cybernetic-provider.js';
import { Spinner } from '@aflow/design-system';

export function CyberneticSpaceShell({ children }: { children: ReactNode }) {
  const params = useParams();
  const { spaces, activeSpace, isLoading } = useSpace();
  const routeSlug = typeof params['space'] === 'string' ? params['space'] : null;

  // Route slug wins. `activeSpace` is the legacy fallback only used on
  // routes that don't carry a `[space]` param (none of which mount this
  // shell in practice, but the fallback keeps the component usable from
  // other contexts).
  const space = routeSlug
    ? (spaces.find((s) => s.slug === routeSlug) ?? null)
    : (activeSpace ?? null);

  if (isLoading || !space) {
    return <CenteredSpinner label="Loading space" />;
  }

  return (
    <CyberneticProvider spaceId={space.id}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--color-cybernetic-ink)',
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </CyberneticProvider>
  );
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}
    >
      <Spinner size="xl" label={label} />
    </div>
  );
}
