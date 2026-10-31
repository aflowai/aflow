/**
 * Who is using Aflow? The local edition's profile picker (Plan 335 D1).
 *
 * One tile per profile, its avatar and its name. A tile is a submit button in
 * a plain form, so the choice works before any script has loaded. The form
 * posts to the web process, which asks the API for the profile's session and
 * keeps it in a cookie no script reads.
 *
 * A locked profile's tile is a link to its PIN prompt instead (Plan 335 P4).
 * The prompt is a plain form too, posting the PIN with the choice. The API
 * checks the PIN, so this component only asks for it.
 *
 * No hooks and no state, so a server component renders it as it stands.
 */
import type { CSSProperties } from 'react';
import type { LocalProfileChoice } from '@aflow/schemas';
import {
  LOCAL_PROFILE_CHOICE_FIELD,
  LOCAL_PROFILE_CHOICE_PATH,
  LOCAL_PROFILE_PICKER_PATH,
  LOCAL_PROFILE_PIN_FIELD,
  localProfileUnlockHref,
  type LocalProfilePinError,
} from '@aflow/web-product';
import { ProfileAvatar } from './profile-avatar.js';

/** What the PIN prompt says when it shows again. */
export const LOCAL_PROFILE_PIN_ERROR_MESSAGES: Record<LocalProfilePinError, string> = {
  required: 'Enter the PIN for this profile.',
  incorrect: 'That PIN is not right. Try again.',
  throttled: 'Too many wrong PINs. Wait a minute, then try again.',
};

const TILE: CSSProperties = {
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
  textDecoration: 'none',
};

const CAPTION: CSSProperties = { fontSize: '0.75rem', color: 'var(--color-content-muted)' };

function TileFace({ profile }: { profile: LocalProfileChoice }) {
  return (
    <>
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
      {profile.isOwner || profile.hasPin ? (
        <span style={CAPTION}>
          {[profile.isOwner ? 'Owner' : null, profile.hasPin ? 'PIN' : null]
            .filter((part) => part !== null)
            .join(' · ')}
        </span>
      ) : null}
    </>
  );
}

/** The PIN prompt for one locked profile. */
function PinPrompt({
  profile,
  error,
}: {
  profile: LocalProfileChoice;
  error: LocalProfilePinError | null;
}) {
  return (
    <form
      method="post"
      action={LOCAL_PROFILE_CHOICE_PATH}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--space-4)',
      }}
    >
      <ProfileAvatar avatar={profile.avatar} name={profile.displayName} size={96} />
      <label
        htmlFor="local-profile-pin"
        style={{ fontSize: '1rem', color: 'var(--color-content-primary)' }}
      >
        Enter the PIN for {profile.displayName}
      </label>
      <input type="hidden" name={LOCAL_PROFILE_CHOICE_FIELD} value={profile.userId} />
      <input
        id="local-profile-pin"
        type="password"
        name={LOCAL_PROFILE_PIN_FIELD}
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]{4,6}"
        minLength={4}
        maxLength={6}
        required
        autoFocus
        aria-describedby={error === null ? undefined : 'local-profile-pin-error'}
        style={{
          width: '10rem',
          padding: 'var(--space-3)',
          fontSize: '1.5rem',
          letterSpacing: '0.5em',
          textAlign: 'center',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-surface-1)',
          color: 'inherit',
        }}
      />
      {error !== null ? (
        <p
          id="local-profile-pin-error"
          role="alert"
          style={{ margin: 0, color: 'var(--color-status-failed-fg)' }}
        >
          {LOCAL_PROFILE_PIN_ERROR_MESSAGES[error]}
        </p>
      ) : null}
      <button
        type="submit"
        style={{
          padding: 'var(--space-2) var(--space-6)',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          background: 'var(--color-accent-default)',
          color: 'var(--color-content-inverse)',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        Continue
      </button>
      <a
        href={LOCAL_PROFILE_PICKER_PATH}
        style={{ color: 'var(--color-content-link)', fontSize: '0.875rem' }}
      >
        Choose another profile
      </a>
    </form>
  );
}

export function ProfilePicker({
  profiles,
  notice,
  backHref,
  unlocking,
}: {
  profiles: readonly LocalProfileChoice[];
  /** Why the browser is here again, such as a session that has ended. */
  notice?: string | null;
  /** Where a browser that already holds a session returns without switching. */
  backHref?: string;
  /** The locked profile whose PIN the picker asks for, in place of the tiles. */
  unlocking?: { profile: LocalProfileChoice; error: LocalProfilePinError | null } | null;
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
      {unlocking ? (
        <PinPrompt profile={unlocking.profile} error={unlocking.error} />
      ) : (
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
          {profiles.map((profile) =>
            profile.hasPin ? (
              <a
                key={profile.userId}
                href={localProfileUnlockHref(profile.userId)}
                aria-label={`Continue as ${profile.displayName}, locked with a PIN`}
                style={TILE}
              >
                <TileFace profile={profile} />
              </a>
            ) : (
              <button
                key={profile.userId}
                type="submit"
                name={LOCAL_PROFILE_CHOICE_FIELD}
                value={profile.userId}
                aria-label={`Continue as ${profile.displayName}`}
                style={TILE}
              >
                <TileFace profile={profile} />
              </button>
            ),
          )}
        </form>
      )}
      {backHref !== undefined ? (
        <a href={backHref} style={{ color: 'var(--color-content-link)', fontSize: '0.875rem' }}>
          Back to Aflow
        </a>
      ) : null}
    </main>
  );
}
