'use client';

import { useEffect, useRef } from 'react';
import { useSpace } from './providers.js';
import { persistPreferredSpaceSlugAction } from '../lib/preferredSpace-actions.js';

export function PreferredSpacePersist({ slug }: { slug: string }) {
  const { spaces, isLoading } = useSpace();
  const lastWrittenRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (lastWrittenRef.current === slug) return;
    // myRole null = no content access (e.g. a foreign personal space in the
    // admin's tenant-wide list) — never persist it as the preferred space.
    const match = spaces.find((s) => s.slug === slug);
    if (!match?.myRole) return;
    lastWrittenRef.current = slug;
    persistPreferredSpaceSlugAction(slug).catch((err: unknown) => {
      // Cookie is a hint — log but don't surface to the user.
      console.warn('[plan-160] persist preferred space failed:', err);
    });
  }, [slug, spaces, isLoading]);

  return null;
}
