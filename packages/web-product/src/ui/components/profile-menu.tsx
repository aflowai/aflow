'use client';

/**
 * The local edition's footer menu (Plan 335 D2): who is using Aflow now, the
 * other profiles to switch to, the picker, Settings → Profiles for the owner
 * and the account page.
 *
 * Local edition only, because a profile is that edition's way of naming who is
 * at the keyboard. The hosted footer opens the account page as it always has.
 */
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Icon,
  MenuItem,
  Popover,
  Text,
  type IconName,
  type PopoverTriggerApi,
} from '@aflow/design-system';
import type { LocalProfileChoicesResponse } from '@aflow/schemas';
import { LOCAL_PROFILE_CHOICE_FIELD, LOCAL_PROFILE_CHOICE_PATH } from '@aflow/web-product';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { ProfileAvatar } from './profile-avatar.js';
import {
  ACCOUNT_SETTINGS_HREF,
  MANAGE_PROFILES_HREF,
  profileMenuEntries,
  type ProfileMenuEntry,
} from './profile-menu-entries.js';
import { UserAvatar, type UserProfile } from './user-avatar.js';

/** Nested under the profiles list's key, so a change in Settings → Profiles refreshes it. */
export const LOCAL_PROFILE_CHOICES_KEY = ['local-profiles', 'picker'] as const;

const LINK_ICONS: Record<string, IconName> = {
  [MANAGE_PROFILES_HREF]: 'gear',
  [ACCOUNT_SETTINGS_HREF]: 'user-circle',
};

export function ProfileMenu({
  user,
  label,
  children,
}: {
  user: UserProfile;
  label: string;
  /** The footer row that opens the menu. */
  children: (api: PopoverTriggerApi) => ReactNode;
}) {
  const router = useRouter();
  const choices = useApiQuery<LocalProfileChoicesResponse>({
    key: [...LOCAL_PROFILE_CHOICES_KEY],
    path: '/local-profiles/picker',
    staleTime: 60_000,
  });
  const entries = profileMenuEntries({
    currentUserId: user.userId,
    isOwner: user.isOwner,
    profiles: choices.data?.profiles ?? null,
  });
  const switches = entries.filter(
    (entry): entry is Extract<ProfileMenuEntry, { kind: 'switch-to' }> =>
      entry.kind === 'switch-to',
  );
  const links = entries.filter(
    (entry): entry is Extract<ProfileMenuEntry, { kind: 'link' }> => entry.kind === 'link',
  );

  return (
    <Popover
      trigger={children}
      placement="right-start"
      width={240}
      aria-label="Profile"
      panelStyle={{ padding: 4, display: 'flex', flexDirection: 'column' }}
    >
      {({ close }) => (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-3)',
            }}
          >
            <UserAvatar user={user} size={32} />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Text size="sm" weight="medium" truncate>
                {label}
              </Text>
              <Text size="xs" variant="muted">
                Using Aflow now
              </Text>
            </div>
          </div>
          {switches.length > 0 ? (
            // A plain post, as the picker's tiles make, so the web process
            // issues the session and keeps it from this page's scripts.
            <form method="post" action={LOCAL_PROFILE_CHOICE_PATH}>
              {switches.map(({ profile }) => (
                <MenuItem
                  key={profile.userId}
                  type="submit"
                  name={LOCAL_PROFILE_CHOICE_FIELD}
                  value={profile.userId}
                  icon={
                    <ProfileAvatar avatar={profile.avatar} name={profile.displayName} size={20} />
                  }
                  label={profile.displayName}
                  description="Switch to this profile"
                  style={{ width: '100%' }}
                />
              ))}
            </form>
          ) : null}
          {links.map((link) => (
            <MenuItem
              key={link.href}
              icon={<Icon name={LINK_ICONS[link.href] ?? 'users'} size="sm" />}
              label={link.label}
              style={{ width: '100%' }}
              onClick={() => {
                close();
                router.push(link.href);
              }}
            />
          ))}
        </>
      )}
    </Popover>
  );
}
