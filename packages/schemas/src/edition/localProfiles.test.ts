/**
 * A local profile stores a built-in avatar as a key in `users.avatar_url`
 * (Plan 335 D2), and a picture's address is never read as one.
 */
import { describe, expect, it } from 'vitest';

import {
  CreateLocalProfileRequestSchema,
  LOCAL_PROFILE_AVATARS,
  UpdateLocalProfileRequestSchema,
  isLocalProfileAvatarUrl,
  localProfileAvatarUrl,
  readLocalProfileAvatar,
} from './localProfiles.js';

describe('built-in avatars', () => {
  it('read back every avatar they store', () => {
    for (const { key } of LOCAL_PROFILE_AVATARS) {
      expect(readLocalProfileAvatar(localProfileAvatarUrl(key))).toBe(key);
      expect(isLocalProfileAvatarUrl(localProfileAvatarUrl(key))).toBe(true);
    }
  });

  it('read a picture address, an unknown key and nothing as no avatar', () => {
    for (const value of ['https://example.com/fox.png', 'aflow-avatar:dragon', null, undefined]) {
      expect(readLocalProfileAvatar(value)).toBeNull();
    }
    expect(isLocalProfileAvatarUrl('https://example.com/fox.png')).toBe(false);
  });
});

describe('profile requests', () => {
  it('trim the name and refuse a blank one', () => {
    expect(CreateLocalProfileRequestSchema.parse({ displayName: '  Sam ', avatar: 'fox' })).toEqual(
      { displayName: 'Sam', avatar: 'fox' },
    );
    expect(
      CreateLocalProfileRequestSchema.safeParse({ displayName: '  ', avatar: 'fox' }).success,
    ).toBe(false);
  });

  it('refuse an avatar that is not built in and a field the routes do not take', () => {
    expect(
      CreateLocalProfileRequestSchema.safeParse({ displayName: 'Sam', avatar: 'dragon' }).success,
    ).toBe(false);
    expect(
      CreateLocalProfileRequestSchema.safeParse({ displayName: 'Sam', avatar: 'fox', pin: '1234' })
        .success,
    ).toBe(false);
  });

  it('refuse an edit that changes nothing', () => {
    expect(UpdateLocalProfileRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateLocalProfileRequestSchema.safeParse({ avatar: 'owl' }).success).toBe(true);
  });
});
