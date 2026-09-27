export interface HealthRecorder {
  /**
   * Record a provider auth error for a credential.
   * Transitions status from 'active' → 'error'.
   * Fire-and-forget — should not block the executor.
   */
  recordError(
    credentialId: string,
    error: { errorCode: string; errorMessage?: string; timestamp: Date },
  ): Promise<void>;

  /**
   * Record a successful provider call.
   * Transitions status from 'error' → 'active'.
   * Debounced — at most once per minute per credential.
   */
  recordSuccess(credentialId: string, timestamp: Date): Promise<void>;
}

/**
 * Health recorder that updates the DB via a provided update function.
 * The update function is injected so this module doesn't depend on a DB client directly.
 */
export type HealthUpdateFn = (
  credentialId: string,
  update: {
    status: 'active' | 'error';
    lastValidatedAt?: Date;
    lastErrorAt?: Date;
    lastErrorCode?: string | null;
  },
) => Promise<void>;

export class CredentialHealthRecorder implements HealthRecorder {
  private readonly updateFn: HealthUpdateFn;
  /** Track last success write time per credential to debounce. */
  private readonly lastSuccessWrite = new Map<string, number>();
  private readonly debounceMs: number;

  constructor(updateFn: HealthUpdateFn, debounceMs = 60_000) {
    this.updateFn = updateFn;
    this.debounceMs = debounceMs;
  }

  async recordError(
    credentialId: string,
    error: { errorCode: string; errorMessage?: string; timestamp: Date },
  ): Promise<void> {
    try {
      await this.updateFn(credentialId, {
        status: 'error',
        lastErrorAt: error.timestamp,
        lastErrorCode: error.errorCode,
      });
    } catch {
      // Fire-and-forget — log but don't propagate
    }
  }

  async recordSuccess(credentialId: string, timestamp: Date): Promise<void> {
    const lastWrite = this.lastSuccessWrite.get(credentialId) ?? 0;
    if (Date.now() - lastWrite < this.debounceMs) {
      return; // Debounced
    }

    try {
      await this.updateFn(credentialId, {
        status: 'active',
        lastValidatedAt: timestamp,
        lastErrorCode: null,
      });
      this.lastSuccessWrite.set(credentialId, Date.now());
    } catch {
      // Fire-and-forget — log but don't propagate
    }
  }
}
