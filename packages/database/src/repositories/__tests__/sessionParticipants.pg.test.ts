/**
 * The membership state machine against a real database: speaking joins,
 * inviting is idempotent, declining sticks until a re-invite bumps the
 * generation (a NEW Action Center identity), and the pending-invites view
 * feeds the Workbench. Gated on DATABASE_URL like every pg test.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql as drizzleSql } from 'drizzle-orm';
import { createDatabase } from '../../connection.js';
import { createTenantContext } from '../../tenant/context.js';
import { withTenantSchema } from '../../tenant/queries.js';
import type { TenantContext } from '../../tenant/context.js';
import {
  getSessionParticipant,
  inviteParticipant,
  listPendingInvitesForUser,
  listSessionParticipants,
  setParticipantStatus,
  upsertJoinedParticipant,
} from '../sessionParticipants.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('session_participants — the durable roster state machine (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const sql = handle.sql;
  const tenantCtx: TenantContext = createTenantContext(TENANT_ID as never);

  const SESSION = randomUUID();
  const HOST = randomUUID();
  const GUEST = randomUUID();

  let schemaReady = false;

  beforeAll(async () => {
    const rows = await sql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'session_participants'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
  });

  afterAll(async () => {
    if (schemaReady) {
      await withTenantSchema(db, tenantCtx, (tx) =>
        tx.execute(
          drizzleSql`DELETE FROM session_participants WHERE session_id = ${SESSION}::uuid`,
        ),
      );
    }
    await handle.close();
  });

  it('walks the whole lifecycle: speak-join, invite, decline, re-invite bumps generation, join', async (ctx) => {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} lacks session_participants (run migrations)`);
      return;
    }

    // Speaking enrolls the host as joined. Nothing was pending, so no
    // invitation card is retired by it.
    const host = await withTenantSchema(db, tenantCtx, (tx) =>
      upsertJoinedParticipant(tx, SESSION, HOST),
    );
    expect(host.member.status).toBe('joined');
    expect(host.member.joinedAt).not.toBeNull();
    expect(host.consumedInvite).toBe(false);

    // Inviting a fresh person creates an invited row at generation 1;
    // repeating it is a no-op at the same generation.
    const first = await withTenantSchema(db, tenantCtx, (tx) =>
      inviteParticipant(tx, { sessionId: SESSION, userId: GUEST, invitedBy: HOST }),
    );
    expect(first.changed).toBe(true);
    expect(first.member.status).toBe('invited');
    expect(first.member.generation).toBe(1);
    const repeat = await withTenantSchema(db, tenantCtx, (tx) =>
      inviteParticipant(tx, { sessionId: SESSION, userId: GUEST, invitedBy: HOST }),
    );
    expect(repeat.changed).toBe(false);
    expect(repeat.member.generation).toBe(1);

    // The pending view feeds the Workbench and the Action Center.
    const pending = await withTenantSchema(db, tenantCtx, (tx) =>
      listPendingInvitesForUser(tx, GUEST),
    );
    expect(pending.some((row) => row.member.sessionId === SESSION)).toBe(true);

    // Decline sticks; a leave-guard transition misses it.
    const declined = await withTenantSchema(db, tenantCtx, (tx) =>
      setParticipantStatus(tx, {
        sessionId: SESSION,
        userId: GUEST,
        from: ['invited'],
        to: 'declined',
      }),
    );
    expect(declined?.status).toBe('declined');
    const badLeave = await withTenantSchema(db, tenantCtx, (tx) =>
      setParticipantStatus(tx, {
        sessionId: SESSION,
        userId: GUEST,
        from: ['joined'],
        to: 'left',
      }),
    );
    expect(badLeave).toBeNull();

    // Re-invite after decline bumps the generation — a NEW invitation identity.
    const reinvite = await withTenantSchema(db, tenantCtx, (tx) =>
      inviteParticipant(tx, { sessionId: SESSION, userId: GUEST, invitedBy: HOST }),
    );
    expect(reinvite.changed).toBe(true);
    expect(reinvite.member.status).toBe('invited');
    expect(reinvite.member.generation).toBe(2);

    // Accepting joins; the roster lists both, joined and invited excluded of
    // declined/left; inviting an already-joined member is a no-op.
    // The guest was `invited`, so this join retires their invitation card —
    // the transition the Action Center wake is gated on.
    const guestJoin = await withTenantSchema(db, tenantCtx, (tx) =>
      upsertJoinedParticipant(tx, SESSION, GUEST),
    );
    expect(guestJoin.consumedInvite).toBe(true);
    const roster = await withTenantSchema(db, tenantCtx, (tx) =>
      listSessionParticipants(tx, SESSION),
    );
    expect(roster.map((member) => member.status)).toEqual(['joined', 'joined']);
    const inviteJoined = await withTenantSchema(db, tenantCtx, (tx) =>
      inviteParticipant(tx, { sessionId: SESSION, userId: GUEST, invitedBy: HOST }),
    );
    expect(inviteJoined.changed).toBe(false);
    expect(inviteJoined.member.status).toBe('joined');

    const loaded = await withTenantSchema(db, tenantCtx, (tx) =>
      getSessionParticipant(tx, SESSION, GUEST),
    );
    expect(loaded?.generation).toBe(2);
  });
});
