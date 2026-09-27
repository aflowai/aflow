import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  jsonb,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Host bindings (host-lane authority — operator-created, outside flows)
// ============================================================================

/**
 * A space-scoped designation of one folder on the operator's own machine, and
 * whether a run may write in it.
 *
 * This is one half of the authority. The paired executor keeps its own policy
 * file, outside any path a job can write, and the effective grant is the
 * intersection: a binding declared here that the machine does not offer reaches
 * nothing, which is what keeps a compromised appliance from inventing access to
 * a folder the operator never connected.
 *
 * The root is recorded for the operator to recognise, and is never the thing
 * that authorises: the executor resolves paths against its own copy.
 */
export const hostBindings = pgTable(
  'host_bindings',
  {
    /** Opaque handle. The same id the host policy file uses for this folder. */
    hostBindingId: text('host_binding_id').notNull(),

    /** Owning space — part of the composite PK. */
    spaceId: uuid('space_id').notNull(),

    /** What the operator calls this folder. */
    label: text('label').notNull(),

    /** Absolute path on the operator's machine, as they declared it. */
    root: text('root').notNull(),

    /** Whether a run may write, as opposed to read. */
    writable: boolean('writable').notNull().default(false),

    /**
     * Whether commands may run here at all. A folder can be connected for
     * reading and writing files without granting a shell, and that is the
     * default: execution is the larger grant and is chosen, never inherited.
     */
    allowsExecution: boolean('allows_execution').notNull().default(false),

    /**
     * Which branches a push from this folder may move, as a prefix. Null means
     * none: a folder that allows commands is not thereby a folder whose history
     * anything may publish.
     *
     * The machine keeps its own copy, as it does of every other grant here, and
     * refuses a push this column alone would admit.
     */
    branchPrefix: text('branch_prefix'),

    /**
     * Local MCP servers this folder offers — ids, names, and what each said it
     * can do when it was connected. Never a command: what an id runs is in the
     * machine's own policy, which nothing here can write.
     *
     * The tool list is recorded rather than fetched because the appliance
     * cannot reach the machine to ask. It comes from the machine itself, which
     * started each server and asked it, at the moment the folder was connected.
     * That makes it a snapshot: a server whose tools change is reconnected, the
     * same way a cached remote tool list is refreshed.
     */
    mcpServers: jsonb('mcp_servers')
      .$type<
        Array<{
          id: string;
          label: string;
          tools?:
            | Array<{
                name: string;
                description?: string | undefined;
                inputSchema?: Record<string, unknown> | undefined;
              }>
            | undefined;
        }>
      >()
      .notNull()
      .default([]),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.hostBindingId] }),
    index('idx_host_bindings_space').on(table.spaceId),
  ],
);

export type HostBindingRow = typeof hostBindings.$inferSelect;
export type NewHostBindingRow = typeof hostBindings.$inferInsert;
