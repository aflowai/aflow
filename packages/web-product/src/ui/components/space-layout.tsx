/**
 * Everything a space route needs established before its screen renders.
 *
 * The slug is validated syntactically first: anything failing that cannot name a
 * real space, so there is nothing to render a shell around. What follows is
 * ordered — the history redirect may replace the slug, persistence records the
 * one that survived, and the access gate decides whether this viewer may see it.
 *
 * Shared because none of it is an edition's business: a space is a space in both,
 * and the alternative is each application repeating an order it must not get
 * wrong.
 */
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { SpaceSlugSchema } from '@aflow/schemas';

import { PreferredSpacePersist } from './preferred-space-persist.js';
import { SpaceAccessGate } from './space-access-gate.js';
import { SpaceSlugHistoryRedirect } from './space-slug-history-redirect.js';

export async function SpaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ space: string }>;
}) {
  const { space: spaceSlug } = await params;

  // Syntactic gate — kebab-case, 1..64 chars, UUID-shape rejected.
  const parsed = SpaceSlugSchema.safeParse(spaceSlug);
  if (!parsed.success) {
    notFound();
  }

  return (
    <>
      <SpaceSlugHistoryRedirect slug={parsed.data} />
      <PreferredSpacePersist slug={parsed.data} />
      <SpaceAccessGate slug={parsed.data}>{children}</SpaceAccessGate>
    </>
  );
}
