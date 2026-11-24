import type { SpaceWriteApprovalPolicy, StoreUpdatePreviewResponse } from '@aflow/schemas';
import type {
  ClientResult,
  HeldWrite,
  RehearsalClient,
  RehearsedRun,
  RehearsedTask,
} from './rehearseBundle.js';

export interface HttpRehearsalClientOptions {
  /** The API origin, without `/v1`. */
  apiUrl: string;
  /** An API key of a member who may administer the space. */
  apiKey: string;
  tenantId?: string | undefined;
  spaceId: string;
  fetchImpl?: typeof fetch;
  /** How long a session starting a run may take to hand back its run. */
  startTimeoutMs?: number;
}

/** The platform's answer to a call that did not succeed. */
export class RehearsalApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`${path} answered ${String(status)}: ${body.slice(0, 500)}`);
    this.name = 'RehearsalApiError';
  }
}

function errorText(err: unknown): string {
  if (err instanceof RehearsalApiError) {
    try {
      const parsed = JSON.parse(err.body) as { error?: unknown; message?: unknown };
      const parts = [parsed.error, parsed.message].filter((p) => typeof p === 'string');
      if (parts.length > 0) return parts.join(': ');
    } catch {
      // The body is not JSON: the status and the raw text say what there is.
    }
  }
  return err instanceof Error ? err.message : String(err);
}

interface SessionView {
  status: string;
  error?: { message?: string; code?: string } | undefined;
}

interface RunSummary {
  runId: string;
  startedAt: string;
}

/**
 * A `RehearsalClient` over the platform's REST API, the routes the web app
 * and the MCP server use. A run starts through the `mcp-runner` platform
 * role running `workflow.run.start`, as `run_operation` does, because the
 * operation, with its catalog pin and its campaign gate, is the one way a run
 * starts.
 */
export class HttpRehearsalClient implements RehearsalClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpRehearsalClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private space(path: string): string {
    return `/v1/spaces/${this.options.spaceId}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'X-Request-ID': crypto.randomUUID(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.tenantId) headers['X-Tenant-ID'] = this.options.tenantId;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.fetchImpl(`${this.options.apiUrl}${path}`, init);
    if (!response.ok) throw new RehearsalApiError(response.status, await response.text(), path);
    return (await response.json()) as T;
  }

  async readInstall(catalogId: string): ReturnType<RehearsalClient['readInstall']> {
    try {
      const preview = await this.request<StoreUpdatePreviewResponse>(
        'POST',
        this.space('/store/update-preview'),
        { catalogId },
      );
      return {
        ok: true,
        installedVersion: preview.currentVersion,
        catalogVersion: preview.catalogVersion,
        installedContentHash: preview.installedContentHash,
        catalogContentHash: preview.catalogContentHash,
        customized: preview.divergence.customized,
      };
    } catch (err) {
      if (err instanceof RehearsalApiError && err.status === 404) {
        return { ok: false, message: errorText(err) };
      }
      throw err;
    }
  }

  async applyUpdate(catalogId: string, expectedVersion: number): Promise<ClientResult<object>> {
    try {
      await this.request('POST', this.space('/store/update'), {
        catalogId,
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
        mode: 'update',
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof RehearsalApiError) return { ok: false, message: errorText(err) };
      throw err;
    }
  }

  async readWritePolicy(): Promise<SpaceWriteApprovalPolicy | null> {
    const read = await this.request<{ writePolicy: SpaceWriteApprovalPolicy | null }>(
      'GET',
      this.space('/write-policy'),
    );
    return read.writePolicy;
  }

  async writeWritePolicy(policy: SpaceWriteApprovalPolicy | null): Promise<void> {
    await this.request('PUT', this.space('/write-policy'), { writePolicy: policy });
  }

  async startCampaign(
    slug: string,
    config: Record<string, unknown>,
  ): Promise<ClientResult<{ campaignId: string; created: boolean }>> {
    try {
      const started = await this.request<{ campaign: { campaignId: string }; created: boolean }>(
        'POST',
        this.space(`/workflows/${encodeURIComponent(slug)}/campaigns`),
        { config },
      );
      return { ok: true, campaignId: started.campaign.campaignId, created: started.created };
    } catch (err) {
      if (err instanceof RehearsalApiError && err.status < 500) {
        return { ok: false, message: errorText(err) };
      }
      throw err;
    }
  }

  async endCampaign(slug: string, campaignId: string): Promise<void> {
    await this.request(
      'POST',
      this.space(`/workflows/${encodeURIComponent(slug)}/campaigns/${campaignId}/end`),
      { reason: 'explicit' },
    );
  }

  private async newestRunSince(slug: string, since: number): Promise<string | null> {
    const listed = await this.request<{ runs: RunSummary[] }>(
      'GET',
      this.space(`/workflows/${encodeURIComponent(slug)}/runs?limit=5`),
    );
    const fresh = listed.runs
      .filter((r) => Date.parse(r.startedAt) >= since)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return fresh[0]?.runId ?? null;
  }

  async startRun(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ runId: string }>> {
    // The stack's clock and this one may disagree a little: a run counts as
    // this one from shortly before the request.
    const since = Date.now() - 5_000;
    const sq = `spaceId=${encodeURIComponent(this.options.spaceId)}`;
    const session = await this.request<{ sessionId: string; error?: { message: string } }>(
      'POST',
      `/v1/sessions?${sq}`,
      {
        mode: 'api',
        target: { kind: 'platform-role', systemRole: 'mcp-runner' },
        input: {
          input: {},
          config: {
            operationId: 'workflow.run.start',
            inputs: { slug, catalogId: skillCatalogId, inputs, wait: 'none' },
          },
        },
      },
    );
    if (session.error) return { ok: false, message: session.error.message };
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 120_000);
    while (Date.now() < deadline) {
      const view = await this.request<SessionView>(
        'GET',
        `/v1/sessions/${session.sessionId}?${sq}`,
      );
      const status = view.status.toUpperCase();
      if (status === 'FAILED' || status === 'CANCELLED') {
        const why = [view.error?.code, view.error?.message].filter((s) => s !== undefined);
        return {
          ok: false,
          message: why.length > 0 ? why.join(': ') : `the starting session ended ${status}`,
        };
      }
      if (status === 'SUCCEEDED') {
        const runId = await this.newestRunSince(slug, since);
        return runId === null
          ? { ok: false, message: `the starting session succeeded, and no run of ${slug} started` }
          : { ok: true, runId };
      }
      await this.sleep(1_000);
    }
    return { ok: false, message: 'the starting session did not finish in time' };
  }

  async readRun(runId: string): Promise<RehearsedRun> {
    const detail = await this.request<{
      run: { status: string; pausedReason?: string };
      tasks: RehearsedTask[];
    }>('GET', this.space(`/workflow-runs/${runId}`));
    return {
      status: detail.run.status,
      pausedReason: detail.run.pausedReason,
      tasks: detail.tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        failureReason: t.failureReason,
        errorCode: t.errorCode,
        workerSessionId: t.workerSessionId,
      })),
    };
  }

  async cancelRun(runId: string, reason: string): Promise<void> {
    await this.request('POST', this.space(`/workflow-runs/${runId}/cancel`), { reason });
  }

  async listHeldWrites(): Promise<HeldWrite[]> {
    const listed = await this.request<{ items: HeldWrite[] }>(
      'GET',
      this.space('/action-center?kind=write_approval'),
    );
    return listed.items.map((item) => ({ id: item.id, origin: item.origin, title: item.title }));
  }

  async refuseWrite(write: HeldWrite, reason: string): Promise<void> {
    await this.request(
      'POST',
      this.space(`/action-center/${encodeURIComponent(write.id)}/resolve`),
      {
        origin: write.origin,
        resolution: { kind: 'reject', reason },
      },
    );
  }

  now(): Date {
    return new Date();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
