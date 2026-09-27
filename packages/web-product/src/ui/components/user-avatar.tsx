'use client';

import { useMemo } from 'react';
import { realAvatarUrl } from './room/ParticipantBadge.js';
import { Icon } from '@aflow/design-system';
import type { CSSProperties } from 'react';

import { useApiQuery } from '../hooks/useApiQuery.js';

export interface UserProfile {
  /** Needed to tell yourself apart from everyone else in a shared room. */
  userId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  /** Whether the user is an admin (owner or admin) in their current tenant */
  isAdmin: boolean;
}

interface TenantMembership {
  tenantId: string;
  role: string;
  status: string;
}

/** Expected shape of GET /api/users/me */
interface MeResponse {
  user: unknown;
  tenants?: TenantMembership[];
}

function isUserProfile(obj: unknown): obj is Omit<UserProfile, 'isAdmin'> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'displayName' in obj &&
    typeof (obj as UserProfile).displayName === 'string' &&
    'userId' in obj &&
    typeof (obj as UserProfile).userId === 'string'
  );
}

export function useCurrentUser(): UserProfile | null {
  const { data } = useApiQuery<MeResponse>({
    key: ['users', 'me'],
    path: '/users/me',
    staleTime: 5 * 60_000,
    // Identity is read by per-row components (Action Center rows, Workbench run
    // rows), so this key is held many times over on a busy screen. Letting each
    // later mount re-drive an errored query puts the cost of one refusal back
    // on the number of rows.
    retryOnMount: false,
  });

  return useMemo<UserProfile | null>(() => {
    if (!data) return null;
    const u = data.user;
    if (!isUserProfile(u)) return null;
    const isAdmin =
      data.tenants?.some(
        (t) => t.status === 'active' && (t.role === 'owner' || t.role === 'admin'),
      ) ?? false;
    return { ...u, isAdmin };
  }, [data]);
}

export function UserAvatar({ user, size = 24 }: { user: UserProfile | null; size?: number }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
  };

  const realUrl = realAvatarUrl(user?.avatarUrl ?? null);
  if (realUrl) {
    return <img src={realUrl} alt="" style={style} referrerPolicy="no-referrer" />;
  }

  return <Icon name="user-circle" size="lg" />;
}
