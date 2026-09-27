'use client';

import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { useSpace } from './providers.js';

/**
 * A slug that is unknown, or resolves to a space the user has no role in
 * (myRole null — e.g. a foreign solo space in an admin's tenant-wide list),
 * renders the not-found state instead of a dead space shell that would
 * otherwise hang on the space never resolving.
 */
export function SpaceAccessGate({ slug, children }: { slug: string; children: ReactNode }) {
  const { spaces, isLoading } = useSpace();
  if (!isLoading) {
    const match = spaces.find((s) => s.slug === slug);
    // Unknown slug (no match → undefined) or a redacted non-member space
    // (myRole null) both resolve to not-found.
    if (match?.myRole == null) {
      notFound();
    }
  }
  return <>{children}</>;
}
