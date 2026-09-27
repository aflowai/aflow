// ============================================================================
// Stream Entry Types
// ============================================================================

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export interface PendingEntry {
  id: string;
  consumer: string;
  idleTime: number;
  deliveryCount: number;
}
