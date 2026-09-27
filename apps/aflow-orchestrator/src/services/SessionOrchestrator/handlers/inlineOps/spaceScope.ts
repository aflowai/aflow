/**
 * Space-scoping utilities for inline operation handlers.
 *
 * All inline operations that touch the database MUST be scoped to the run's
 * space. This module provides centralized helpers to enforce that boundary.
 *
 * Usage:
 *   const spaceId = requireSpaceId(context);
 *   // Then pass spaceId to queries as a WHERE filter
 */
import { eq, and, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { FlowExecutionContext } from '../../types.js';

/**
 * Extract the run's spaceId from context or throw.
 * Every inline op that touches the DB must call this.
 */
export function requireSpaceId(context: FlowExecutionContext): string {
  if (!context.spaceId) {
    throw new Error('Operation requires a space context. The run must belong to a space.');
  }
  return context.spaceId;
}

/**
 * Build a WHERE clause that includes a space_id equality check.
 * Combines with any existing conditions via AND.
 *
 * Usage:
 *   .where(withSpaceFilter(agentDefinitions.spaceId, spaceId, eq(agentDefinitions.agentId, flowId)))
 */
export function withSpaceFilter(spaceColumn: PgColumn, spaceId: string, ...conditions: SQL[]): SQL {
  return and(eq(spaceColumn, spaceId), ...conditions)!;
}
