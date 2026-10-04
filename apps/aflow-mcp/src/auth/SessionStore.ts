/**
 * In-memory session store for MCP sessions.
 * Each MCP session (identified by Mcp-Session-Id) has its own auth state.
 *
 * Phase 2: Redis-backed for horizontal scaling.
 */

import { backgroundTaskControlPlane } from '@aflow/schemas';
import type { SessionAuth } from './types.js';

export interface Session {
  /** MCP session ID (from transport) */
  id: string;
  /** Auth state for this session */
  auth: SessionAuth;
  /** When the session was created */
  createdAt: number;
  /** Last activity timestamp */
  lastActivityAt: number;
  /**
   * Dev-only defaults from AFLOW_MCP_LOCAL_AUTH_JSON (never set in production).
   */
  mcpLocalDefaults?: { defaultSpaceId?: string } | undefined;
  /**
   * The digest of the session token that gave this session the owner's key;
   * every later request on it presents that token again.
   */
  sessionTokenDigest?: Buffer | undefined;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    const runtime = backgroundTaskControlPlane().resolve('mcp-server.session_store_cleanup');
    if (runtime.mode === 'enabled') {
      this.cleanupTimer = setInterval(() => {
        this.cleanup();
      }, runtime.intervalMs ?? CLEANUP_INTERVAL_MS);
    }
  }

  create(sessionId: string): Session {
    const now = Date.now();
    const session: Session = {
      id: sessionId,
      auth: { method: 'none' },
      createdAt: now,
      lastActivityAt: now,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // Expiry is enforced at the read, not only by the sweeper: the sweeper is a
    // registered task an operator may disable, and the registry calls that
    // disable safe — which is only true if a stale session cannot be honoured
    // through the front door regardless.
    if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    session.lastActivityAt = Date.now();
    return session;
  }

  getOrCreate(sessionId: string): Session {
    return this.get(sessionId) ?? this.create(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.sessions.clear();
  }
}
