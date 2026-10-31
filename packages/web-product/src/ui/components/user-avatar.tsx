'use client';

import { useMemo } from 'react';
import { readLocalProfileAvatar } from '@aflow/schemas';
import { realAvatarUrl } from './room/ParticipantBadge.js';
import { ProfileAvatar } from './profile-avatar.js';
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
  /** Whether the user owns their current tenant: the local install's owner, locally. */
  isOwner: boolean;
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

function isUserProfile(obj: unknown): obj is Omit<UserProfile, 'isAdmin' | 'isOwner'> {
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
    const active = data.tenants?.filter((t) => t.status === 'active') ?? [];
    const isAdmin = active.some((t) => t.role === 'owner' || t.role === 'admin');
    const isOwner = active.some((t) => t.role === 'owner');
    return { ...u, isAdmin, isOwner };
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

  const builtIn = readLocalProfileAvatar(user?.avatarUrl);
  if (builtIn) return <ProfileAvatar avatar={builtIn} size={size} />;

  const realUrl = realAvatarUrl(user?.avatarUrl ?? null);
  if (realUrl) {
    return <img src={realUrl} alt="" style={style} referrerPolicy="no-referrer" />;
  }

  return <Icon name="user-circle" size="lg" />;
}
