/**
 * The local edition's profiles as the owner manages them (Plan 335 P2).
 *
 * A profile is a `users` row with an active membership in the pinned tenant.
 * These are the shapes the management routes take and answer, and the
 * built-in avatars a profile chooses from.
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
  createdAt: z.string().datetime(),
});
export type LocalProfile = z.infer<typeof LocalProfileSchema>;

export const LocalProfileListResponseSchema = z.object({
  profiles: z.array(LocalProfileSchema),
});
export type LocalProfileListResponse = z.infer<typeof LocalProfileListResponseSchema>;

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
