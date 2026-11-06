'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useSpaceFromRoute } from './providers.js';
import { APP_TITLE, spacePageTitle } from '../lib/page-title.js';

/**
 * Names the space page in the browser title. The space's name is known only
 * on the client, so route metadata cannot carry it. Next may write the root
 * metadata's title again after a navigation, so the head is watched and the
 * name put back.
 */
export function SpacePageTitle(): null {
  const pathname = usePathname();
  const space = useSpaceFromRoute();
  const title = spacePageTitle(pathname, space?.name);

  useEffect(() => {
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = APP_TITLE;
    };
  }, [title]);

  return null;
}
