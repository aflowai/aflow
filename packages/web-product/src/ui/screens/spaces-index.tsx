'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@aflow/design-system';
import { useSpace } from '../components/providers.js';

/**
 * Where a front door that could not resolve a space sends the visitor.
 *
 * It selects nothing itself. `SpaceGate` answers this route before its children
 * render whenever there is no space or none chosen — the onboarding flow or the
 * picker — so reaching here means a space is active and chat is where they were
 * going.
 */
export function SpacesIndexPage() {
  const { activeSpace } = useSpace();
  const router = useRouter();
  const slug = activeSpace?.slug;

  useEffect(() => {
    if (slug !== undefined) router.replace(`/s/${encodeURIComponent(slug)}/chat`);
  }, [slug, router]);

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100%', padding: '2rem' }}>
      <Spinner size="xl" label="Opening your workspace" />
    </div>
  );
}
