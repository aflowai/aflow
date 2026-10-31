'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useEdition } from '../hooks/useEdition.js';
import { firstSettingsTab } from '../components/tenant-settings/tabs.js';
import { useCurrentUser } from '../components/user-avatar.js';

/**
 * Settings has no page of its own; it opens on its first tab.
 *
 * Which tab that is depends on the edition — the local one does not register
 * the membership surface the hosted product opens on, so a fixed redirect
 * would land on a page whose every call 404s.
 */
export function TenantSettingsIndex() {
  const router = useRouter();
  const edition = useEdition();
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.isOwner ?? false;

  useEffect(() => {
    if (edition.isLoading || currentUser === null) return;
    router.replace(firstSettingsTab({ edition, isOwner }));
  }, [router, edition, currentUser, isOwner]);

  return null;
}
