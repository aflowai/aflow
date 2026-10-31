/**
 * Who is using Aflow? The local edition's profile picker (Plan 335 D1).
 *
 * One tile per profile, its avatar and its name. A tile is a submit button in
 * a plain form, so the choice works before any script has loaded. The form
 * posts to the web process, which asks the API for the profile's session and
 * keeps it in a cookie no script reads.
 *
 * No hooks and no state, so a server component renders it as it stands.
 */
import type { LocalProfileChoice } from '@aflow/schemas';
import { LOCAL_PROFILE_CHOICE_FIELD, LOCAL_PROFILE_CHOICE_PATH } from '@aflow/web-product';
import { ProfileAvatar } from './profile-avatar.js';

export function ProfilePicker({
  profiles,
  notice,
  backHref,
}: {
  profiles: readonly LocalProfileChoice[];
  /** Why the browser is here again, such as a session that has ended. */
  notice?: string | null;
  /** Where a browser that already holds a session returns without switching. */
  backHref?: string;
}) {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-8)',
        padding: 'var(--space-8)',
        background: 'var(--color-surface-canvas)',
        color: 'var(--color-content-primary)',
      }}
    >
      <h1
        style={{
          fontFamily: 'var(--font-family-title)',
          fontSize: '1.75rem',
          fontWeight: 400,
          margin: 0,
        }}
      >
        Who is using Aflow?
      </h1>
      {notice ? (
        <p role="status" style={{ margin: 0, color: 'var(--color-content-secondary)' }}>
          {notice}
        </p>
      ) : null}
      <form
        method="post"
        action={LOCAL_PROFILE_CHOICE_PATH}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 'var(--space-6)',
          maxWidth: '48rem',
        }}
      >
        {profiles.map((profile) => (
          <button
            key={profile.userId}
            type="submit"
            name={LOCAL_PROFILE_CHOICE_FIELD}
            value={profile.userId}
            aria-label={`Continue as ${profile.displayName}`}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-3)',
              width: '8rem',
              padding: 'var(--space-3)',
              border: '1px solid transparent',
              borderRadius: 'var(--radius-md)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            <ProfileAvatar avatar={profile.avatar} name={profile.displayName} size={96} />
            <span
              style={{
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {profile.displayName}
            </span>
            {profile.isOwner ? (
              <span style={{ fontSize: '0.75rem', color: 'var(--color-content-muted)' }}>
                Owner
              </span>
            ) : null}
          </button>
        ))}
      </form>
      {backHref !== undefined ? (
        <a href={backHref} style={{ color: 'var(--color-content-link)', fontSize: '0.875rem' }}>
          Back to Aflow
        </a>
      ) : null}
    </main>
  );
}
