'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApi, useSpace } from './providers.js';

interface RedirectResponse {
  slug?: string;
  redirect?: { fromSlug: string; toSlug: string };
}

export function SpaceSlugHistoryRedirect({ slug }: { slug: string }) {
  const { spaces, isLoading } = useSpace();
  const { apiUrl, headers } = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const attemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (attemptedRef.current === slug) return;
    // Slug is live → nothing to do.
    if (spaces.find((s) => s.slug === slug)) return;
    attemptedRef.current = slug;

    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${apiUrl}/spaces/by-slug/${encodeURIComponent(slug)}`, {
          headers: headers(),
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as RedirectResponse;
        const canonical = body.redirect?.toSlug ?? body.slug;
        if (!canonical || canonical === slug) return;
        // Rewrite the slug segment in place; preserve the rest of the
        //   path and the querystring so a deep link survives the
        //   rename. router.replace (not push) — the old slug shouldn't
        //   leave a back-button entry.
        const nextPath = pathname.replace(
          new RegExp(`^/s/${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?=/|$)`),
          `/s/${canonical}`,
        );
        const qs = searchParams.toString();
        router.replace(qs ? `${nextPath}?${qs}` : nextPath);
      } catch {
        /* best-effort */
      }
    })();

    return () => {
      controller.abort();
    };
  }, [slug, spaces, isLoading, apiUrl, headers, router, pathname, searchParams]);

  return null;
}
