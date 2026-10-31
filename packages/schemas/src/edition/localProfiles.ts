/**
 * The local edition's profiles as the owner manages them (Plan 335 P2), as
 * the picker offers them (P3), and the PIN that locks one (P4).
 *
 * A profile is a `users` row with an active membership in the pinned tenant.
 * These are the shapes the management and picker routes take and answer, and
 * the built-in avatars a profile chooses from.
 */
import { z } from 'zod';
import { TenantRoleSchema } from '../identity/user.js';

/**
 * The built-in avatars (Plan 335 D2). No upload in this cut, so a profile
 * stores one of these keys rather than a picture.
 */
export const LOCAL_PROFILE_AVATARS = [
  { key: 'fox', label: 'Fox', glyph: '🦊' },
  { key: 'owl', label: 'Owl', glyph: '🦉' },
  { key: 'cat', label: 'Cat', glyph: '🐱' },
  { key: 'panda', label: 'Panda', glyph: '🐼' },
  { key: 'frog', label: 'Frog', glyph: '🐸' },
  { key: 'octopus', label: 'Octopus', glyph: '🐙' },
  { key: 'penguin', label: 'Penguin', glyph: '🐧' },
  { key: 'whale', label: 'Whale', glyph: '🐳' },
] as const;

export type LocalProfileAvatar = (typeof LOCAL_PROFILE_AVATARS)[number]['key'];

export const LocalProfileAvatarSchema = z.enum(
  LOCAL_PROFILE_AVATARS.map((avatar) => avatar.key) as [
    LocalProfileAvatar,
    ...LocalProfileAvatar[],
  ],
);

/**
 * `users.avatar_url` holds a built-in avatar under this scheme. A scheme of
 * its own keeps the key from reading as a picture's address, and leaves the
 * column free for an account's picture later (Plan 335 §5).
 */
const AVATAR_SCHEME = 'aflow-avatar:';

export function localProfileAvatarUrl(avatar: LocalProfileAvatar): string {
  return `${AVATAR_SCHEME}${avatar}`;
}

/** The built-in avatar an `avatar_url` names, or null for anything else. */
export function readLocalProfileAvatar(
  avatarUrl: string | null | undefined,
): LocalProfileAvatar | null {
  if (!avatarUrl?.startsWith(AVATAR_SCHEME)) return null;
  const parsed = LocalProfileAvatarSchema.safeParse(avatarUrl.slice(AVATAR_SCHEME.length));
  return parsed.success ? parsed.data : null;
}

/** Whether an `avatar_url` holds a built-in avatar key rather than a picture's address. */
export function isLocalProfileAvatarUrl(avatarUrl: string | null | undefined): boolean {
  return avatarUrl?.startsWith(AVATAR_SCHEME) ?? false;
}

/** A display name as a person types it. Trimmed, and never empty. */
export const LocalProfileNameSchema = z
  .string()
  .trim()
  .min(1, 'A profile needs a name.')
  .max(200, 'A profile name is at most 200 characters.');

export const LocalProfileSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  avatar: LocalProfileAvatarSchema.nullable(),
  role: TenantRoleSchema,
  /** The install's owner. The owner manages profiles and cannot be removed. */
  isOwner: z.boolean(),
  /** Whether the profile is locked with a PIN (Plan 335 P4). The PIN itself never leaves the API. */
  hasPin: z.boolean(),
  createdAt: z.string().datetime(),
});
export type LocalProfile = z.infer<typeof LocalProfileSchema>;

export const LocalProfileListResponseSchema = z.object({
  profiles: z.array(LocalProfileSchema),
});
export type LocalProfileListResponse = z.infer<typeof LocalProfileListResponseSchema>;

/**
 * One tile of the picker (Plan 335 D1). The picker answers a browser that
 * holds no profile session, so it carries the name, the avatar and whether
 * the tile asks for a PIN.
 */
export const LocalProfileChoiceSchema = LocalProfileSchema.pick({
  userId: true,
  displayName: true,
  avatar: true,
  isOwner: true,
  hasPin: true,
});
export type LocalProfileChoice = z.infer<typeof LocalProfileChoiceSchema>;

export const LocalProfileChoicesResponseSchema = z.object({
  /** The owner first, then the others in the order they were added. */
  profiles: z.array(LocalProfileChoiceSchema),
});
export type LocalProfileChoicesResponse = z.infer<typeof LocalProfileChoicesResponseSchema>;

/**
 * The session the picker issues for one profile. The web process keeps it in
 * an `httpOnly` cookie, so no script in the browser reads it.
 */
export const LocalProfileSessionResponseSchema = z.object({
  profile: LocalProfileChoiceSchema,
  session: z.string().min(1),
  /**
   * For a locked profile, the mark that gives this browser its own count of
   * wrong PINs (Plan 335 P4). The web process keeps it in an `httpOnly`
   * cookie and sends it back with the next PIN for that profile.
   */
  pinMark: z.string().min(1).optional(),
});
export type LocalProfileSessionResponse = z.infer<typeof LocalProfileSessionResponseSchema>;

/**
 * Whether an install's profiles call for the picker. Two profiles do, and so
 * does one locked with a PIN (Plan 335 P4). One profile with no PIN never does.
 */
export function showsLocalProfilePicker(profiles: ReadonlyArray<{ hasPin: boolean }>): boolean {
  return profiles.length >= 2 || profiles.some((profile) => profile.hasPin);
}

/** Whether there is another profile to switch to. A PIN on the only one adds none. */
export function offersLocalProfileSwitch(profiles: readonly unknown[]): boolean {
  return profiles.length >= 2;
}

/**
 * A profile PIN: four to six digits (Plan 335 D3). Short on purpose, because
 * it keeps one person at a shared browser out of another's profile and claims
 * nothing more. The API throttles wrong guesses.
 */
export const LocalProfilePinSchema = z
  .string()
  .regex(/^[0-9]{4,6}$/, 'A PIN is four to six digits.');

/** Sets or changes a profile's PIN. The owner sends it from Settings → Profiles. */
export const SetLocalProfilePinRequestSchema = z.object({ pin: LocalProfilePinSchema }).strict();
export type SetLocalProfilePinRequest = z.infer<typeof SetLocalProfilePinRequestSchema>;

/**
 * What the picker sends with a choice. A locked profile needs its PIN. A
 * profile with no PIN ignores one.
 *
 * `pinMark` is the mark a right PIN for this profile earlier issued to this
 * browser. Wrong PINs sent with it are counted apart from wrong PINs sent
 * without it, so a browser that never knew the PIN cannot make this one wait.
 */
export const LocalProfileSessionRequestSchema = z
  .object({ pin: z.string().max(64).optional(), pinMark: z.string().max(256).optional() })
  .strict();
export type LocalProfileSessionRequest = z.infer<typeof LocalProfileSessionRequestSchema>;

/**
 * Why the picker issued no session for a locked profile. The web process
 * answers each with the PIN prompt again.
 */
export const LOCAL_PROFILE_PIN_REFUSAL_CODES = [
  'PROFILE_PIN_REQUIRED',
  'PROFILE_PIN_INCORRECT',
  'PROFILE_PIN_THROTTLED',
] as const;
export type LocalProfilePinRefusalCode = (typeof LOCAL_PROFILE_PIN_REFUSAL_CODES)[number];

export function isLocalProfilePinRefusal(code: unknown): code is LocalProfilePinRefusalCode {
  return (LOCAL_PROFILE_PIN_REFUSAL_CODES as readonly unknown[]).includes(code);
}

export const CreateLocalProfileRequestSchema = z
  .object({
    displayName: LocalProfileNameSchema,
    avatar: LocalProfileAvatarSchema,
  })
  .strict();
export type CreateLocalProfileRequest = z.infer<typeof CreateLocalProfileRequestSchema>;

export const CreateLocalProfileResponseSchema = z.object({
  profile: LocalProfileSchema,
  /** The new profile's own `Personal` space. */
  spaceId: z.string().uuid(),
});
export type CreateLocalProfileResponse = z.infer<typeof CreateLocalProfileResponseSchema>;

export const UpdateLocalProfileRequestSchema = z
  .object({
    displayName: LocalProfileNameSchema.optional(),
    avatar: LocalProfileAvatarSchema.optional(),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.avatar !== undefined, {
    message: 'Send a new display name, a new avatar, or both.',
  });
export type UpdateLocalProfileRequest = z.infer<typeof UpdateLocalProfileRequestSchema>;

export const LocalProfileSpaceSchema = z.object({
  spaceId: z.string().uuid(),
  name: z.string(),
});
export type LocalProfileSpace = z.infer<typeof LocalProfileSpaceSchema>;

/** What removing a profile deletes, and what it hands to the owner. */
export const LocalProfileRemovalPreviewSchema = z.object({
  profile: LocalProfileSchema,
  /** Spaces only this profile is in. They are deleted with their content. */
  spacesDeleted: z.array(LocalProfileSpaceSchema),
  /** Spaces this profile owns that others share. The owner takes them over. */
  spacesTransferred: z.array(LocalProfileSpaceSchema),
  /** Rows deleted with the spaces above, by table. */
  deletedRows: z.record(z.number().int().nonnegative()),
});
export type LocalProfileRemovalPreview = z.infer<typeof LocalProfileRemovalPreviewSchema>;

export const RemoveLocalProfileResponseSchema = z.object({
  userId: z.string().uuid(),
  spacesDeleted: z.array(LocalProfileSpaceSchema),
  spacesTransferred: z.array(LocalProfileSpaceSchema),
});
export type RemoveLocalProfileResponse = z.infer<typeof RemoveLocalProfileResponseSchema>;
