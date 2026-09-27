/**
 * SurfaceStore — In-memory state store for a single surface.
 *
 * Maintains:
 * - Component map (id → TypedSurfaceComponent)
 * - Root component IDs (render order)
 * - Data model (JSON-addressable via JSON Pointer)
 * - Surface metadata (id, catalog version, completion state)
 *
 * Framework-agnostic — used by both executor (validation) and frontend (rendering).
 */
import type { SurfaceMutation, SurfaceSnapshot, TypedSurfaceComponent } from '@aflow/schemas';

// =============================================================================
// Types
// =============================================================================

export interface SurfaceState {
  surfaceId: string;
  catalogVersion: string;
  components: Map<string, TypedSurfaceComponent>;
  rootIds: string[];
  dataModel: Record<string, unknown>;
  completed: boolean;
  messageCount: number;
  lastUpdated: string;
  title?: string;
}

export type SurfaceChangeListener = (
  state: Readonly<SurfaceState>,
  mutation: SurfaceMutation,
) => void;

// =============================================================================
// JSON Pointer helpers (RFC 6901)
// =============================================================================

/**
 * Set a value at a JSON Pointer path in an object.
 * Creates intermediate objects as needed.
 * "/" sets the root (replaces entire object).
 */
export function setAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  if (pointer === '' || pointer === '/') {
    // Root replacement
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return root;
  }

  const segments = pointer
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  // Clone to avoid mutation
  const result = { ...root };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (typeof current[seg] !== 'object' || current[seg] === null) {
      current[seg] = {};
    }
    current[seg] = { ...(current[seg] as Record<string, unknown>) };
    current = current[seg] as Record<string, unknown>;
  }

  const lastSeg = segments[segments.length - 1]!;
  current[lastSeg] = value;

  return result;
}

/**
 * Get a value at a JSON Pointer path.
 */
export function getAtPointer(root: Record<string, unknown>, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return root;

  const segments = pointer
    .split('/')
    .filter((s) => s !== '')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = root;
  for (const seg of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

// =============================================================================
// SurfaceStore
// =============================================================================

export class SurfaceStore {
  private state: SurfaceState;
  private listeners = new Set<SurfaceChangeListener>();

  constructor() {
    this.state = {
      surfaceId: '',
      catalogVersion: '',
      components: new Map(),
      rootIds: [],
      dataModel: {},
      completed: false,
      messageCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  /** Get current state (read-only snapshot). */
  getState(): Readonly<SurfaceState> {
    return this.state;
  }

  /** Get a specific component by ID. */
  getComponent(id: string): TypedSurfaceComponent | undefined {
    return this.state.components.get(id);
  }

  /** Get a data model value at a JSON Pointer path. */
  getData(pointer: string): unknown {
    return getAtPointer(this.state.dataModel, pointer);
  }

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe(listener: SurfaceChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply a validated surface mutation to the store.
   * Returns true if applied successfully.
   */
  apply(mutation: SurfaceMutation): boolean {
    const now = mutation.timestamp ?? new Date().toISOString();

    switch (mutation.type) {
      case 'createSurface': {
        // Process dataModel: keys are JSON Pointer paths (e.g., "/sales"),
        // resolve them through setAtPointer just like updateDataModel does.
        let dataModel: Record<string, unknown> = {};
        if (mutation.dataModel) {
          for (const [pointer, value] of Object.entries(mutation.dataModel)) {
            dataModel = setAtPointer(dataModel, pointer, value);
          }
        }
        this.state = {
          surfaceId: mutation.surfaceId,
          catalogVersion: mutation.catalogVersion,
          components: new Map(),
          rootIds: mutation.rootIds ?? [],
          dataModel,
          completed: false,
          messageCount: 1,
          lastUpdated: now,
          ...(mutation.title != null ? { title: mutation.title } : {}),
        };
        // Apply initial components if provided
        if (mutation.components) {
          for (const comp of mutation.components) {
            this.state.components.set(comp.id, comp);
          }
        }
        break;
      }

      case 'updateComponents': {
        if (mutation.surfaceId !== this.state.surfaceId) return false;
        const newComponents = new Map(this.state.components);
        for (const comp of mutation.components) {
          newComponents.set(comp.id, comp);
        }
        this.state = {
          ...this.state,
          components: newComponents,
          rootIds: mutation.rootIds ?? this.state.rootIds,
          messageCount: this.state.messageCount + 1,
          lastUpdated: now,
        };
        break;
      }

      case 'updateDataModel': {
        if (mutation.surfaceId !== this.state.surfaceId) return false;
        let dataModel = this.state.dataModel;
        for (const [pointer, value] of Object.entries(mutation.dataModel)) {
          dataModel = setAtPointer(dataModel, pointer, value);
        }
        this.state = {
          ...this.state,
          dataModel,
          messageCount: this.state.messageCount + 1,
          lastUpdated: now,
        };
        break;
      }

      case 'deleteSurface': {
        if (mutation.surfaceId !== this.state.surfaceId) return false;
        this.state = {
          ...this.state,
          components: new Map(),
          rootIds: [],
          dataModel: {},
          completed: true,
          messageCount: this.state.messageCount + 1,
          lastUpdated: now,
        };
        break;
      }

      case 'completeSurface': {
        if (mutation.surfaceId !== this.state.surfaceId) return false;
        this.state = {
          ...this.state,
          completed: true,
          messageCount: this.state.messageCount + 1,
          lastUpdated: now,
        };
        break;
      }

      case 'surfaceError': {
        if (mutation.surfaceId !== this.state.surfaceId) return false;
        this.state = {
          ...this.state,
          messageCount: this.state.messageCount + 1,
          lastUpdated: now,
        };
        // Error is propagated via the listener, not stored in state
        break;
      }

      default:
        return false;
    }

    // Notify listeners
    for (const listener of this.listeners) {
      listener(this.state, mutation);
    }

    return true;
  }

  /**
   * Export current state as a serializable snapshot.
   */
  toSnapshot(): SurfaceSnapshot {
    const components: Record<string, TypedSurfaceComponent> = {};
    for (const [id, comp] of this.state.components) {
      components[id] = comp;
    }
    return {
      surfaceId: this.state.surfaceId,
      catalogVersion: this.state.catalogVersion,
      components,
      rootIds: [...this.state.rootIds],
      dataModel: { ...this.state.dataModel },
      completed: this.state.completed,
      messageCount: this.state.messageCount,
      lastUpdated: this.state.lastUpdated,
    };
  }

  /**
   * Hydrate store from a snapshot.
   */
  fromSnapshot(snapshot: SurfaceSnapshot): void {
    this.state = {
      surfaceId: snapshot.surfaceId,
      catalogVersion: snapshot.catalogVersion,
      components: new Map(Object.entries(snapshot.components)),
      rootIds: [...snapshot.rootIds],
      dataModel: { ...snapshot.dataModel },
      completed: snapshot.completed,
      messageCount: snapshot.messageCount,
      lastUpdated: snapshot.lastUpdated,
    };
  }

  /** Reset the store to initial empty state. */
  reset(): void {
    this.state = {
      surfaceId: '',
      catalogVersion: '',
      components: new Map(),
      rootIds: [],
      dataModel: {},
      completed: false,
      messageCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
}
