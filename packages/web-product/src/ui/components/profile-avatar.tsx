'use client';

/**
 * A local profile's built-in avatar (Plan 335 D2). The profile stores a key,
 * and this draws it: the glyph on a tint derived from the key, so one avatar
 * looks the same wherever it appears.
 */
import { LOCAL_PROFILE_AVATARS, type LocalProfileAvatar } from '@aflow/schemas';
import { hueOf } from './room/ParticipantBadge.js';

export function ProfileAvatar({
  avatar,
  size = 32,
}: {
  avatar: LocalProfileAvatar | null;
  size?: number;
}) {
  const entry = LOCAL_PROFILE_AVATARS.find((a) => a.key === avatar);
  const hue = hueOf(entry?.key ?? '');
  return (
    <span
      role="img"
      aria-label={entry?.label ?? 'No avatar'}
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.58),
        lineHeight: 1,
        background: entry ? `hsl(${String(hue)} 70% 88%)` : 'var(--color-surface-2)',
        flexShrink: 0,
      }}
    >
      {entry?.glyph ?? ''}
    </span>
  );
}
