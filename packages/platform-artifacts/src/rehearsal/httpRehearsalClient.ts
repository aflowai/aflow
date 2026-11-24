import { z } from 'zod';
import {
  WorkflowRunStartOutputSchema,
  type RehearsalExchangeSource,
  type SpaceWriteApprovalPolicy,
  type StoreUpdatePreviewResponse,
} from '@aflow/schemas';
import { exchangeClockDate, type ExchangeReading } from './exchangeWindow.js';
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
  /**
   * The transport, named by the caller. The rehearsal dials the operator's own
   * stack, often on loopback, which the checked fetchers refuse, so this client
   * picks no default.
   */
  fetchImpl: typeof fetch;
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
  outputRef?: string | undefined;
  error?: { message?: string; code?: string } | undefined;
}

const ExchangeClockSchema = z.object({ timestamp: z.string(), is_open: z.boolean() });
const ExchangeSessionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/),
});

/** How many dates past the clock's date the calendar read covers, so a closed window names when it next opens across a holiday. */
const CALENDAR_LOOKAHEAD_DAYS = 14;

/**
 * The operation's own output inside a `mcp-runner` session's output. The
 * flow maps it to `result`, and an `agent.control.run_step` envelope, which
 * carries `stepExecutionId`, nests it under `result` once more.
 */
function operationOutput(output: unknown): unknown {
  let value = output;
  for (let depth = 0; depth < 2; depth += 1) {
    if (value === null || typeof value !== 'object' || !('result' in value)) break;
    const record = value as Record<string, unknown>;
    if (depth === 1 && !('stepExecutionId' in record)) break;
    value = record['result'];
  }
  return value;
}

function shiftDate(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
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
    this.fetchImpl = options.fetchImpl;
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

  /** A payload the session's output names, read inline or from the payload store. */
  private async readPayload(ref: string): Promise<unknown> {
    if (ref.startsWith('inline:')) {
      const bytes = Uint8Array.from(atob(ref.slice('inline:'.length)), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    }
    const sq = `spaceId=${encodeURIComponent(this.options.spaceId)}`;
    const read = await this.request<unknown>(
      'GET',
      `/v1/payloads?ref=${encodeURIComponent(ref)}&${sq}`,
    );
    const downloadUrl =
      read !== null && typeof read === 'object'
        ? (read as Record<string, unknown>)['downloadUrl']
        : undefined;
    if (typeof downloadUrl !== 'string') return read;
    const response = await this.fetchImpl(downloadUrl);
    if (!response.ok) {
      throw new RehearsalApiError(response.status, await response.text(), 'payload download');
    }
    return (await response.json()) as unknown;
  }

  /**
   * Run one operation through the `mcp-runner` role and return its output.
   * The session's output holds the operation's under `result`, as the
   * role's flow maps it.
   */
  private async runOperation(
    operationId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ output: unknown }>> {
    const sq = `spaceId=${encodeURIComponent(this.options.spaceId)}`;
    const session = await this.request<{ sessionId: string; error?: { message: string } }>(
      'POST',
      `/v1/sessions?${sq}`,
      {
        mode: 'api',
        target: { kind: 'platform-role', systemRole: 'mcp-runner' },
        input: { input: {}, config: { operationId, inputs } },
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
          message: why.length > 0 ? why.join(': ') : `the ${operationId} session ended ${status}`,
        };
      }
      if (status === 'SUCCEEDED') {
        if (view.outputRef === undefined) {
          return { ok: false, message: `the ${operationId} session succeeded with no output` };
        }
        return { ok: true, output: operationOutput(await this.readPayload(view.outputRef)) };
      }
      await this.sleep(1_000);
    }
    return { ok: false, message: `the ${operationId} session did not finish in time` };
  }

  async startRun(
    slug: string,
    skillCatalogId: string,
    inputs: Record<string, unknown>,
  ): Promise<ClientResult<{ runId: string }>> {
    const ran = await this.runOperation('workflow.run.start', {
      slug,
      catalogId: skillCatalogId,
      inputs,
      wait: 'none',
    });
    if (!ran.ok) return ran;
    const started = WorkflowRunStartOutputSchema.safeParse(ran.output);
    if (!started.success) {
      return {
        ok: false,
        message: `workflow.run.start returned no run id: ${JSON.stringify(ran.output).slice(0, 300)}`,
      };
    }
    if (started.data.slug !== slug) {
      return {
        ok: false,
        message: `workflow.run.start started a run of ${started.data.slug}, not ${slug}`,
      };
    }
    return { ok: true, runId: started.data.runId };
  }

  private async readEndpoint(
    source: RehearsalExchangeSource,
    endpointId: string,
    params?: Record<string, string>,
  ): Promise<ClientResult<{ data: unknown }>> {
    const ran = await this.runOperation('api.http.call', {
      apiId: source.apiId,
      endpointId,
      ...(params !== undefined ? { params } : {}),
      response: { format: 'json' },
    });
    if (!ran.ok) return ran;
    const envelope =
      ran.output !== null && typeof ran.output === 'object'
        ? (ran.output as Record<string, unknown>)
        : {};
    const dataRef = envelope['dataRef'];
    const data =
      envelope['data'] === undefined && typeof dataRef === 'string'
        ? await this.readPayload(dataRef)
        : envelope['data'];
    return data === undefined
      ? { ok: false, message: `${source.apiId} ${endpointId} returned no data` }
      : { ok: true, data };
  }

  async readExchange(
    source: RehearsalExchangeSource,
  ): Promise<ClientResult<{ reading: ExchangeReading }>> {
    const clockRead = await this.readEndpoint(source, source.clockEndpointId);
    if (!clockRead.ok) return clockRead;
    const clock = ExchangeClockSchema.safeParse(clockRead.data);
    const date = clock.success ? exchangeClockDate(clock.data.timestamp) : null;
    if (!clock.success || date === null) {
      return {
        ok: false,
        message: `the exchange clock read does not parse: ${JSON.stringify(clockRead.data).slice(0, 300)}`,
      };
    }
    const calendarRead = await this.readEndpoint(source, source.calendarEndpointId, {
      start: date,
      end: shiftDate(date, CALENDAR_LOOKAHEAD_DAYS),
    });
    if (!calendarRead.ok) return calendarRead;
    const sessions = z.array(ExchangeSessionSchema).safeParse(calendarRead.data);
    if (!sessions.success) {
      return {
        ok: false,
        message: `the exchange calendar read does not parse: ${JSON.stringify(calendarRead.data).slice(0, 300)}`,
      };
    }
    return {
      ok: true,
      reading: {
        timestamp: clock.data.timestamp,
        isOpen: clock.data.is_open,
        sessions: sessions.data.map((s) => ({ date: s.date, open: s.open, close: s.close })),
      },
    };
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
