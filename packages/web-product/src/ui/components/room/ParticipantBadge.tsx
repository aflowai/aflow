'use client';

/**
 * One person, drawn the same way everywhere they appear.
 *
 * Shared between the room header and the Workbench list on purpose: a
 * teammate recognisable in one place and not the other defeats the point of
 * showing them at all.
 */

/**
 * Colour is derived from the name so a person looks the same to everyone in
 * the room and across reloads — an arbitrary per-render colour would read as
 * a different person. Shared with the chat's peer-message name tint so the
 * badge and the label always agree.
 */
export function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

/**
 * Auth0 hands database users a generated two-letter image as their `picture`
 * (often riding URL-encoded inside a gravatar fallback param) — same first
 * letters, same face for everyone. That is not a picture of anyone: treat it
 * as absent so the named initials badge renders instead.
 */
export function realAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  const generated =
    url.includes('cdn.auth0.com/avatars') || url.includes('cdn.auth0.com%2Favatars');
  return generated ? null : url;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function ParticipantBadge({
  name,
  avatarUrl,
  role,
  driving,
  overlapping,
  size = 24,
}: {
  name: string;
  avatarUrl: string | null;
  role: 'admin' | 'editor' | 'viewer' | undefined;
  driving: boolean;
  overlapping: boolean;
  size?: number;
}) {
  const hue = hueOf(name);
  // Role rides the label rather than a visible badge: it matters when you are
  // wondering why someone is only watching, not on every glance at the room.
  const label = [name, role === 'viewer' ? 'view-only' : role, driving ? 'driving' : null]
    .filter(Boolean)
    .join(' — ');
  const ring = driving
    ? '0 0 0 2px var(--color-surface-1), 0 0 0 4px var(--color-accent-default)'
    : '0 0 0 2px var(--color-surface-1)';

  // A real picture is the strongest "who is that" signal there is; initials
  // are the fallback for people who never set one.
  const realUrl = realAvatarUrl(avatarUrl);
  if (realUrl) {
    return (
      <img
        src={realUrl}
        alt=""
        title={label}
        aria-label={label}
        referrerPolicy="no-referrer"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          objectFit: 'cover',
          boxShadow: ring,
          marginLeft: overlapping ? -6 : 0,
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size > 24 ? 11 : 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: `hsl(${String(hue)} 70% 24%)`,
        background: `hsl(${String(hue)} 70% 88%)`,
        boxShadow: ring,
        marginLeft: overlapping ? -6 : 0,
        flexShrink: 0,
      }}
    >
      {initialsOf(name)}
    </span>
  );
}
