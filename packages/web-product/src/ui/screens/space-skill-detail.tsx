'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { spaceRoute } from '../lib/space-routes.js';

/**
 * The per-skill detail page is retired into the skills landing, which is now the
 * single home (switcher + Design/Performance/Runs/⋯ tabs). Old deep links —
 * `/skills/{slug}?tab=health|proposals-feedback|definition|…` — redirect to
 * `/skills?skill={slug}&tab=…`; the landing aliases the legacy tab names.
 */
export function SkillSlugRedirect() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const spaceSlug = String(params['space']);
  const slug = String(params['slug']);
  const tab = searchParams?.get('tab') ?? 'design';

  useEffect(() => {
    router.replace(spaceRoute(spaceSlug, `/skills?skill=${slug}&tab=${tab}`));
  }, [router, spaceSlug, slug, tab]);

  return null;
}
