/**
 * Memory Directory Repository.
 *
 * Manages explicit directory entities for filesystem-like navigation.
 * Directories are auto-created on memory.store.put (mkdir -p) and can be
 * created explicitly via memory.mkdir.
 */
import { eq, and, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { APPLET_MEMORY_PREFIX } from '@aflow/schemas';
import { TASK_DRAFT_DIR_PATH } from './reservedPaths.js';

import type { TenantContext } from '../tenant.js';
import { withTenantSchema } from '../tenant.js';
import { memoryDirs, memoryDocs } from '../schema/tenant.js';
import type { MemoryDirRow } from '../schema/tenant.js';
import { canonicalizePath, targetsAppletReservedSubtree } from './memoryPaths.js';

// ============================================================================
// Types
// ============================================================================

export interface MemoryDir {
  id: string;
  path: string;
  name: string;
  parentPath: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  spaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  createdByActor: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface MemoryDirScope {
  spaceId: string;
  userId?: string | undefined;
  agentId?: string | undefined;
  sessionId?: string | undefined;
}

export interface MkdirParams {
  path: string;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
  scope: MemoryDirScope;
  parents?: boolean | undefined;
  createdByActor?: string | undefined;
}

export interface MkdirResult {
  id: string;
  path: string;
  created: boolean;
}

export interface ListDirOptions {
  scope: MemoryDirScope;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface DirListItem {
  entryType: 'directory' | 'document';
  id: string;
  path: string;
  name: string;
  updatedAt: Date;
  // Document-specific
  docType?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  preview?: string | null | undefined;
  // Directory-specific
  description?: string | null | undefined;
  childCount?: { dirs: number; docs: number } | undefined;
  // Scope fields
  spaceId?: string | undefined;
  userId?: string | null | undefined;
  agentId?: string | null | undefined;
  sessionId?: string | null | undefined;
}

export interface MemoryDirRepository {
  getDir(path: string, spaceId: string): Promise<MemoryDir | null>;
  getDirById(id: string, spaceId: string): Promise<MemoryDir | null>;
  mkdir(params: MkdirParams): Promise<MkdirResult>;
  ensureParentDirs(docPath: string, scope: MemoryDirScope, createdByActor?: string): Promise<void>;
  listDir(parentPath: string, options: ListDirOptions): Promise<DirListItem[]>;
  deleteDir(path: string, spaceId: string, recursive?: boolean): Promise<boolean>;
  /** Restore a soft-deleted directory (clear deletedAt). */
  restoreDir(path: string, spaceId: string): Promise<boolean>;
  withTransaction<T>(fn: (txRepo: MemoryDirRepository) => Promise<T>): Promise<T>;
}

// ============================================================================
// Helpers
// ============================================================================

function toDir(row: MemoryDirRow): MemoryDir {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    parentPath: row.parentPath,
    description: row.description,
    metadata: row.metadata,
    tags: row.tags,
    spaceId: row.spaceId,
    userId: row.userId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    createdByActor: row.createdByActor,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/**
 * Extract the parent directory path from a canonical path.
 * e.g., '/spaces/myspace/readme.md' → '/spaces/myspace'
 *        '/spaces' → '/'
 *        '/' → null
 */
function parentOf(canonicalPath: string): string | null {
  if (canonicalPath === '/') return null;
  const lastSlash = canonicalPath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return canonicalPath.substring(0, lastSlash);
}

/**
 * Extract the name (last segment) from a canonical path.
 * e.g., '/spaces/myspace' → 'myspace'
 *        '/' → ''
 */
function nameOf(canonicalPath: string): string {
  if (canonicalPath === '/') return '';
  const lastSlash = canonicalPath.lastIndexOf('/');
  return canonicalPath.substring(lastSlash + 1);
}

/**
 * Return all ancestor directory paths for a given canonical path,
 * ordered from root down (excluding the path itself).
 * e.g., '/a/b/c' → ['/', '/a', '/a/b']
 */
function ancestorsOf(canonicalPath: string): string[] {
  const ancestors: string[] = [];
  let current = parentOf(canonicalPath);
  while (current !== null) {
    ancestors.unshift(current);
    current = parentOf(current);
  }
  return ancestors;
}

// ============================================================================
// Repository Implementation
// ============================================================================

type QueryRunner = <T>(fn: (tx: PostgresJsDatabase) => Promise<T>) => Promise<T>;

export function createMemoryDirRepository(
  db: PostgresJsDatabase,
  tenantContext: TenantContext,
  options?: { inTransaction?: boolean },
): MemoryDirRepository {
  const run: QueryRunner = options?.inTransaction
    ? async (fn) => fn(db)
    : async (fn) => withTenantSchema(db, tenantContext, fn);

  return {
    async getDir(path, spaceId) {
      return run(async (tx) => {
        const canonical = canonicalizePath(path);
        const [row] = await tx
          .select()
          .from(memoryDirs)
          .where(
            and(
              eq(memoryDirs.path, canonical),
              eq(memoryDirs.spaceId, spaceId),
              sql`${memoryDirs.deletedAt} IS NULL`,
            ),
          )
          .limit(1);
        return row ? toDir(row) : null;
      });
    },

    async getDirById(id, spaceId) {
      return run(async (tx) => {
        const [row] = await tx
          .select()
          .from(memoryDirs)
          .where(
            and(
              eq(memoryDirs.id, id),
              eq(memoryDirs.spaceId, spaceId),
              sql`${memoryDirs.deletedAt} IS NULL`,
            ),
          )
          .limit(1);
        return row ? toDir(row) : null;
      });
    },

    async mkdir(params) {
      const canonical = canonicalizePath(params.path);
      const doParents = params.parents !== false;

      return run(async (tx) => {
        const scope = params.scope;
        if (doParents) {
          const ancestors = ancestorsOf(canonical);
          for (const ancestor of ancestors) {
            await tx.execute(sql`
              INSERT INTO ${memoryDirs} (path, name, parent_path, tags, metadata,
                space_id, user_id, agent_id, session_id)
              VALUES (
                ${ancestor},
                ${nameOf(ancestor)},
                ${parentOf(ancestor)},
                '[]'::jsonb,
                '{}'::jsonb,
                ${scope.spaceId},
                ${scope.userId ?? null},
                ${scope.agentId ?? null},
                ${scope.sessionId ?? null}
              )
              ON CONFLICT (path, space_id) DO UPDATE SET
                deleted_at = NULL,
                space_id = EXCLUDED.space_id,
                updated_at = NOW()
            `);
          }
        }

        // Try to find existing directory (including soft-deleted) at this path+space
        const lookupConditions: SQL[] = [
          eq(memoryDirs.path, canonical),
          eq(memoryDirs.spaceId, scope.spaceId),
        ];

        const existing = await tx
          .select({ id: memoryDirs.id, deletedAt: memoryDirs.deletedAt })
          .from(memoryDirs)
          .where(and(...lookupConditions))
          .limit(1);

        if (existing[0]) {
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          // Revive if soft-deleted
          if (existing[0].deletedAt) updates['deletedAt'] = null;
          if (params.description !== undefined) updates['description'] = params.description;
          if (params.metadata !== undefined) updates['metadata'] = params.metadata;
          if (params.tags !== undefined) updates['tags'] = params.tags;
          await tx.update(memoryDirs).set(updates).where(eq(memoryDirs.id, existing[0].id));
          return { id: existing[0].id, path: canonical, created: !!existing[0].deletedAt };
        }

        const insertValues: Record<string, unknown> = {
          path: canonical,
          name: nameOf(canonical),
          parentPath: parentOf(canonical),
          description: params.description ?? null,
          metadata: params.metadata ?? {},
          tags: params.tags ?? [],
          spaceId: scope.spaceId,
        };
        if (scope.userId) insertValues['userId'] = scope.userId;
        if (scope.agentId) insertValues['agentId'] = scope.agentId;
        if (scope.sessionId) insertValues['sessionId'] = scope.sessionId;
        if (params.createdByActor) insertValues['createdByActor'] = params.createdByActor;

        const [inserted] = await tx
          .insert(memoryDirs)
          .values(insertValues as typeof memoryDirs.$inferInsert)
          .returning({ id: memoryDirs.id });

        return { id: inserted!.id, path: canonical, created: true };
      });
    },

    async ensureParentDirs(docPath, scope, createdByActor) {
      const canonical = canonicalizePath(docPath);
      const ancestors = ancestorsOf(canonical);
      // Also include the doc's immediate parent
      const docParent = parentOf(canonical);
      if (docParent && !ancestors.includes(docParent)) {
        ancestors.push(docParent);
      }

      if (ancestors.length === 0) return;

      return run(async (tx) => {
        for (const dirPath of ancestors) {
          const insertValues: Record<string, unknown> = {
            path: dirPath,
            name: nameOf(dirPath),
            parentPath: parentOf(dirPath),
            tags: [],
            metadata: {},
            spaceId: scope.spaceId,
          };
          if (scope.userId) insertValues['userId'] = scope.userId;
          if (scope.agentId) insertValues['agentId'] = scope.agentId;
          if (scope.sessionId) insertValues['sessionId'] = scope.sessionId;
          if (createdByActor) insertValues['createdByActor'] = createdByActor;

          await tx.execute(sql`
            INSERT INTO ${memoryDirs} (path, name, parent_path, tags, metadata,
              space_id, user_id, agent_id, session_id, created_by_actor)
            VALUES (
              ${dirPath},
              ${nameOf(dirPath)},
              ${parentOf(dirPath)},
              '[]'::jsonb,
              '{}'::jsonb,
              ${scope.spaceId},
              ${scope.userId ?? null},
              ${scope.agentId ?? null},
              ${scope.sessionId ?? null},
              ${createdByActor ?? null}
            )
            ON CONFLICT (path, space_id) DO UPDATE SET
              deleted_at = NULL,
              space_id = EXCLUDED.space_id,
              updated_at = NOW()
          `);
        }
      });
    },

    async listDir(parentPathRaw, options) {
      const parentCanonical = canonicalizePath(parentPathRaw);
      const limit = options.limit ?? 100;
      const scopeFilter = options.scope;
      // The reserved applet-state subtree stays out of directory browsing
      // unless the listed parent itself points inside it.
      const hideAppletSubtree = !targetsAppletReservedSubtree(parentCanonical);
      const appletDirPath = APPLET_MEMORY_PREFIX.slice(0, -1);

      return run(async (tx) => {
        // 1. Fetch immediate child directories, filtered by scope.
        // Also use EXISTS to ensure directories contain at least one
        // matching document somewhere in their subtree.
        const dirConditions: SQL[] = [
          sql`${memoryDirs.deletedAt} IS NULL`,
          eq(memoryDirs.parentPath, parentCanonical),
        ];
        // Directories and documents merge into one name-ordered stream, so the
        // keyset cursor is a `name` compared in byte order (COLLATE "C") — the
        // one collation JS string comparison reproduces exactly, keeping the
        // emitted cursor and this filter in agreement across pages.
        if (options.cursor) {
          dirConditions.push(sql`${memoryDirs.name} COLLATE "C" > ${options.cursor}`);
        }
        if (hideAppletSubtree) {
          dirConditions.push(
            sql`${memoryDirs.path} <> ${appletDirPath}`,
            sql`${memoryDirs.path} NOT LIKE ${APPLET_MEMORY_PREFIX + '%'}`,
          );
        }

        // Run-attempt scratch, hidden here for the same reason as applet state
        // and on the same terms: the directory route enumerates the same rows
        // the flat listing does.
        dirConditions.push(
          sql`${memoryDirs.path} <> ${TASK_DRAFT_DIR_PATH}`,
          sql`${memoryDirs.path} NOT LIKE ${TASK_DRAFT_DIR_PATH + '/%'}`,
        );

        // Filter directories by scope fields directly to avoid duplicates
        // (since migration 33, path is unique per space_id, so the same path
        // can have multiple directory records across spaces).
        dirConditions.push(eq(memoryDirs.spaceId, scopeFilter.spaceId));
        if (scopeFilter.userId) {
          dirConditions.push(eq(memoryDirs.userId, scopeFilter.userId));
        }
        if (scopeFilter.agentId) {
          dirConditions.push(eq(memoryDirs.agentId, scopeFilter.agentId));
        }
        if (scopeFilter.sessionId) {
          dirConditions.push(eq(memoryDirs.sessionId, scopeFilter.sessionId));
        }

        // Only show directories that contain at least one matching document
        // somewhere in their subtree (within the same scope).
        {
          const scopeDocConditions: SQL[] = [
            sql`d.deleted_at IS NULL`,
            sql`(d.expires_at IS NULL OR d.expires_at > NOW())`,
            // Document path starts with the directory's path + '/'
            sql`d.path LIKE ${memoryDirs.path} || '/%'`,
            sql`d.space_id = ${scopeFilter.spaceId}`,
          ];
          if (scopeFilter.userId) scopeDocConditions.push(sql`d.user_id = ${scopeFilter.userId}`);
          if (scopeFilter.agentId)
            scopeDocConditions.push(sql`d.agent_id = ${scopeFilter.agentId}`);
          if (scopeFilter.sessionId)
            scopeDocConditions.push(sql`d.session_id = ${scopeFilter.sessionId}`);

          dirConditions.push(
            sql`EXISTS (SELECT 1 FROM ${memoryDocs} d WHERE ${and(...scopeDocConditions)})`,
          );
        }

        const dirRows = await tx
          .select({
            id: memoryDirs.id,
            path: memoryDirs.path,
            name: memoryDirs.name,
            description: memoryDirs.description,
            updatedAt: memoryDirs.updatedAt,
            spaceId: memoryDirs.spaceId,
            userId: memoryDirs.userId,
            agentId: memoryDirs.agentId,
            sessionId: memoryDirs.sessionId,
          })
          .from(memoryDirs)
          .where(and(...dirConditions))
          .orderBy(sql`${memoryDirs.name} COLLATE "C"`)
          .limit(limit);

        // 2. Fetch immediate child documents
        const docPrefix = parentCanonical === '/' ? '/' : parentCanonical + '/';
        const docConditions: SQL[] = [
          sql`${memoryDocs.deletedAt} IS NULL`,
          sql`(${memoryDocs.expiresAt} IS NULL OR ${memoryDocs.expiresAt} > NOW())`,
          sql`${memoryDocs.path} LIKE ${docPrefix + '%'}`,
          sql`${memoryDocs.path} NOT LIKE ${docPrefix + '%/%'}`,
        ];
        if (hideAppletSubtree) {
          docConditions.push(sql`${memoryDocs.path} NOT LIKE ${APPLET_MEMORY_PREFIX + '%'}`);
        }
        // Hiding the draft DIRECTORY from its parent is not enough: a caller
        // that aims a pathPrefix straight at the reserved subtree lists the
        // documents inside it, ids and previews included.
        docConditions.push(sql`${memoryDocs.path} NOT LIKE ${TASK_DRAFT_DIR_PATH + '/%'}`);
        docConditions.push(eq(memoryDocs.spaceId, scopeFilter.spaceId));
        if (scopeFilter.userId) docConditions.push(eq(memoryDocs.userId, scopeFilter.userId));
        if (scopeFilter.agentId) docConditions.push(eq(memoryDocs.agentId, scopeFilter.agentId));
        if (scopeFilter.sessionId)
          docConditions.push(eq(memoryDocs.sessionId, scopeFilter.sessionId));
        // A child document's name is its path minus the constant docPrefix, so
        // the shared `name` keyset applies as `path > docPrefix + cursor`.
        if (options.cursor) {
          docConditions.push(sql`${memoryDocs.path} COLLATE "C" > ${docPrefix + options.cursor}`);
        }

        const docRows = await tx
          .select({
            id: memoryDocs.id,
            path: memoryDocs.path,
            docType: memoryDocs.docType,
            mimeType: memoryDocs.mimeType,
            sizeBytes: memoryDocs.sizeBytes,
            updatedAt: memoryDocs.updatedAt,
            preview: memoryDocs.preview,
            spaceId: memoryDocs.spaceId,
            userId: memoryDocs.userId,
            agentId: memoryDocs.agentId,
            sessionId: memoryDocs.sessionId,
          })
          .from(memoryDocs)
          .where(and(...docConditions))
          .orderBy(sql`${memoryDocs.path} COLLATE "C"`)
          .limit(limit);

        // 3. Compute child counts for each directory (batch query)
        const dirPaths = dirRows.map((d) => d.path);
        const childCounts = new Map<string, { dirs: number; docs: number }>();

        if (dirPaths.length > 0) {
          // Count child dirs per parent
          const dirPathsArr = sql`ARRAY[${sql.join(
            dirPaths.map((p) => sql`${p}`),
            sql`, `,
          )}]::text[]`;
          const dirCountRows = await tx.execute(sql`
            SELECT parent_path, COUNT(*)::int AS cnt
            FROM ${memoryDirs}
            WHERE parent_path = ANY(${dirPathsArr})
              AND deleted_at IS NULL
            GROUP BY parent_path
          `);
          for (const r of dirCountRows as unknown as Array<Record<string, unknown>>) {
            const pp = String(r['parent_path']);
            if (!childCounts.has(pp)) childCounts.set(pp, { dirs: 0, docs: 0 });
            childCounts.get(pp)!.dirs = Number(r['cnt']);
          }

          // Count child docs per parent dir
          // Uses an unnested approach: for each dir path, count docs whose path
          // matches dirPath/% but not dirPath/%/%
          const docCountRows = await tx.execute(sql`
            SELECT dp.dir_path, COUNT(d.id)::int AS cnt
            FROM unnest(${dirPathsArr}) AS dp(dir_path)
            LEFT JOIN ${memoryDocs} d
              ON d.path LIKE dp.dir_path || '/%'
              AND d.path NOT LIKE dp.dir_path || '/%/%'
              AND d.deleted_at IS NULL
              AND (d.expires_at IS NULL OR d.expires_at > NOW())
            GROUP BY dp.dir_path
          `);
          for (const r of docCountRows as unknown as Array<Record<string, unknown>>) {
            const dp = String(r['dir_path']);
            if (!childCounts.has(dp)) childCounts.set(dp, { dirs: 0, docs: 0 });
            childCounts.get(dp)!.docs = Number(r['cnt']);
          }
        }

        // 4. Merge and sort by name
        const items: DirListItem[] = [];

        for (const dir of dirRows) {
          items.push({
            entryType: 'directory',
            id: dir.id,
            path: dir.path,
            name: dir.name,
            updatedAt: dir.updatedAt,
            description: dir.description,
            childCount: childCounts.get(dir.path) ?? { dirs: 0, docs: 0 },
            spaceId: dir.spaceId,
            userId: dir.userId,
            agentId: dir.agentId,
            sessionId: dir.sessionId,
          });
        }

        for (const doc of docRows) {
          items.push({
            entryType: 'document',
            id: doc.id,
            path: doc.path,
            name: nameOf(doc.path),
            updatedAt: doc.updatedAt,
            docType: doc.docType,
            mimeType: doc.mimeType,
            sizeBytes: doc.sizeBytes,
            preview: doc.preview,
            spaceId: doc.spaceId,
            userId: doc.userId,
            agentId: doc.agentId,
            sessionId: doc.sessionId,
          });
        }

        // Byte-order comparison to match the SQL COLLATE "C" keyset, so the
        // merged order and the emitted `name` cursor stay in agreement.
        items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return items.slice(0, limit);
      });
    },

    async deleteDir(pathRaw, spaceId, recursive) {
      const canonical = canonicalizePath(pathRaw);

      return run(async (tx) => {
        // Check if directory exists
        const [dir] = await tx
          .select({ id: memoryDirs.id })
          .from(memoryDirs)
          .where(
            and(
              eq(memoryDirs.path, canonical),
              eq(memoryDirs.spaceId, spaceId),
              sql`${memoryDirs.deletedAt} IS NULL`,
            ),
          )
          .limit(1);

        if (!dir) return false;

        if (!recursive) {
          // Check for children
          const [childDir] = await tx
            .select({ id: memoryDirs.id })
            .from(memoryDirs)
            .where(
              and(
                eq(memoryDirs.parentPath, canonical),
                eq(memoryDirs.spaceId, spaceId),
                sql`${memoryDirs.deletedAt} IS NULL`,
              ),
            )
            .limit(1);

          const docPrefix = canonical === '/' ? '/' : canonical + '/';
          const [childDoc] = await tx
            .select({ id: memoryDocs.id })
            .from(memoryDocs)
            .where(
              and(
                sql`${memoryDocs.path} LIKE ${docPrefix + '%'}`,
                eq(memoryDocs.spaceId, spaceId),
                sql`${memoryDocs.deletedAt} IS NULL`,
              ),
            )
            .limit(1);

          if (childDir || childDoc) {
            throw new Error(
              `MEMORY_DIR_NOT_EMPTY: directory '${canonical}' has children. Use recursive=true to delete.`,
            );
          }
        }

        const now = new Date();

        if (recursive) {
          const prefix = canonical === '/' ? '/' : canonical + '/';
          // Soft-delete all descendant directories (scoped to this space —
          // the path prefix alone is shared across spaces).
          await tx
            .update(memoryDirs)
            .set({ deletedAt: now })
            .where(
              and(
                sql`(${memoryDirs.path} LIKE ${prefix + '%'} OR ${memoryDirs.path} = ${canonical})`,
                eq(memoryDirs.spaceId, spaceId),
                sql`${memoryDirs.deletedAt} IS NULL`,
              ),
            );
          // Soft-delete all descendant documents (scoped to this space).
          await tx
            .update(memoryDocs)
            .set({ deletedAt: now })
            .where(
              and(
                sql`${memoryDocs.path} LIKE ${prefix + '%'}`,
                eq(memoryDocs.spaceId, spaceId),
                sql`${memoryDocs.deletedAt} IS NULL`,
              ),
            );
        }

        // Soft-delete the directory itself
        await tx.update(memoryDirs).set({ deletedAt: now }).where(eq(memoryDirs.id, dir.id));

        return true;
      });
    },

    async restoreDir(pathRaw, spaceId) {
      const canonical = canonicalizePath(pathRaw);
      return run(async (tx) => {
        const result = await tx
          .update(memoryDirs)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(memoryDirs.path, canonical),
              eq(memoryDirs.spaceId, spaceId),
              sql`${memoryDirs.deletedAt} IS NOT NULL`,
            ),
          )
          .returning({ id: memoryDirs.id });
        return result.length > 0;
      });
    },

    async withTransaction<T>(fn: (txRepo: MemoryDirRepository) => Promise<T>): Promise<T> {
      if (options?.inTransaction) {
        return fn(this);
      }
      return withTenantSchema(db, tenantContext, async (tx) => {
        const txRepo = createMemoryDirRepository(tx, tenantContext, { inTransaction: true });
        return fn(txRepo);
      });
    },
  };
}
