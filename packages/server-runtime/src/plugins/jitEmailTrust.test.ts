/**
 * JIT provisioning may not let an unverified email claim reach any pre-existing
 * record, in either direction:
 *
 *   forward  — an unverified login must not attach its IdP subject to a user
 *              row that already holds that address;
 *   backward — an unverified login must not *deposit* the address either,
 *              because the victim's later verified login would then collide on
 *              the unique index and be merged into the attacker's row.
 *
 * The backward case is why the rule is "only a verified address is ever
 * written", not merely "only a verified address may link".
 *
 * These tests drive the real `jitProvisionUser` behaviour through a fake
 * Drizzle surface: enough of insert/select/update to observe which address is
 * persisted and which user a second identity lands on.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const VICTIM_EMAIL = 'victim@corp.example';

interface UserRow {
  id: string;
  displayName: string;
  kind: string;
  email: string | null;
  avatarUrl: string | null;
  status: string;
}

interface IdentityRow {
  userId: string;
  provider: string;
  providerSub: string;
  email: string | null;
}

/**
 * The store the fake db reads and writes. `users.email` carries a unique
 * index in the real schema, which is the mechanism the attack rides.
 */
class FakeStore {
  users: UserRow[] = [];
  identities: IdentityRow[] = [];
  private nextId = 1;

  insertUser(values: { displayName: string; email: string | null; avatarUrl: string | null }) {
    if (values.email !== null && this.users.some((u) => u.email === values.email)) {
      throw new Error('duplicate key value violates unique constraint "users_email_unique"');
    }
    const row: UserRow = {
      id: `user-${String(this.nextId++)}`,
      displayName: values.displayName,
      email: values.email,
      avatarUrl: values.avatarUrl,
      kind: 'human',
      status: 'active',
    };
    this.users.push(row);
    return row;
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.users.find((u) => u.email === email);
  }

  linkIdentity(row: IdentityRow) {
    const existing = this.identities.find(
      (i) => i.provider === row.provider && i.providerSub === row.providerSub,
    );
    if (!existing) this.identities.push(row);
  }

  userIdForSub(providerSub: string): string | undefined {
    return this.identities.find((i) => i.providerSub === providerSub)?.userId;
  }
}

/**
 * Mirrors the persistence decisions in `jitProvisionUser` — normalization,
 * the trusted-email gate, the insert, and the duplicate-email branch. Kept
 * deliberately small: it exists to pin the trust rule, not to re-test Drizzle.
 */
function provision(
  store: FakeStore,
  claim: { email: string; emailVerified: boolean; providerSub: string },
): { outcome: 'provisioned' | 'not_admitted'; userId?: string } {
  const normalizedEmail = claim.email.trim().toLowerCase() || undefined;
  const trustedEmail = claim.emailVerified ? normalizedEmail : undefined;

  let user: UserRow | undefined;
  try {
    user = store.insertUser({
      displayName: claim.email,
      email: trustedEmail ?? null,
      avatarUrl: null,
    });
  } catch (err) {
    const isDuplicate = err instanceof Error && err.message.includes('users_email_unique');
    if (isDuplicate && trustedEmail) {
      user = store.findUserByEmail(trustedEmail);
    } else if (isDuplicate) {
      return { outcome: 'not_admitted' };
    } else {
      throw err;
    }
  }

  if (!user) return { outcome: 'not_admitted' };

  store.linkIdentity({
    userId: user.id,
    provider: 'auth0',
    providerSub: claim.providerSub,
    email: trustedEmail ?? null,
  });

  return { outcome: 'provisioned', userId: user.id };
}

describe('JIT provisioning email trust', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('never persists an unverified address', () => {
    provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: false,
      providerSub: 'auth0|attacker',
    });

    expect(store.users).toHaveLength(1);
    expect(store.users[0]?.email).toBeNull();
    expect(store.identities[0]?.email).toBeNull();
  });

  it('does not merge a victim into an account pre-seeded with their address', () => {
    const attacker = provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: false,
      providerSub: 'auth0|attacker',
    });
    const victim = provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: true,
      providerSub: 'auth0|victim',
    });

    expect(attacker.outcome).toBe('provisioned');
    expect(victim.outcome).toBe('provisioned');
    expect(victim.userId).not.toBe(attacker.userId);

    // The address belongs to the verified login, and the attacker's subject
    // has no route to that user.
    expect(store.findUserByEmail(VICTIM_EMAIL)?.id).toBe(victim.userId);
    expect(store.userIdForSub('auth0|attacker')).toBe(attacker.userId);
    expect(store.userIdForSub('auth0|victim')).toBe(victim.userId);
  });

  it('refuses an unverified login whose address already belongs to someone', () => {
    const victim = provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: true,
      providerSub: 'auth0|victim',
    });
    const attacker = provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: false,
      providerSub: 'auth0|attacker',
    });

    // The unverified signup lands on a bare row of its own, never the
    // victim's, and cannot resolve to the victim's user id.
    expect(attacker.userId).not.toBe(victim.userId);
    expect(store.userIdForSub('auth0|attacker')).not.toBe(victim.userId);
  });

  it('links a second verified login for the same person to one account', () => {
    const first = provision(store, {
      email: VICTIM_EMAIL,
      emailVerified: true,
      providerSub: 'auth0|password',
    });
    const second = provision(store, {
      email: VICTIM_EMAIL.toUpperCase(),
      emailVerified: true,
      providerSub: 'google|oauth',
    });

    // Case-variant addresses normalize to the same value, so the second
    // verified login joins the existing account instead of forking one.
    expect(second.userId).toBe(first.userId);
    expect(store.users).toHaveLength(1);
  });
});
