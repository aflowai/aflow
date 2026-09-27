/**
 * Internal HTTP client for calling the Aflow Platform API.
 *
 * Each tool call creates a request with the session's auth headers.
 */

import { randomUUID } from 'node:crypto';
import type { McpServerConfig } from '../config.js';
import type { AuthManager } from '../auth/AuthManager.js';
import type { Session } from '../auth/SessionStore.js';
import { log } from '../util/logger.js';

export class ApiClient {
  readonly baseUrl: string;

  constructor(
    private readonly config: McpServerConfig,
    private readonly authManager: AuthManager,
  ) {
    this.baseUrl = config.apiUrl;
  }

  async get<T>(session: Session, path: string): Promise<T> {
    return this.request<T>(session, 'GET', path);
  }

  async post<T>(session: Session, path: string, body?: unknown): Promise<T> {
    return this.request<T>(session, 'POST', path, body);
  }

  getAuthHeaders(session: Session): Record<string, string> {
    return this.authManager.getAuthHeaders(session);
  }

  private async request<T>(
    session: Session,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.authManager.getAuthHeaders(session);
    const requestId = randomUUID();
    headers['X-Request-ID'] = requestId;
    headers['X-MCP-Client'] = 'aflow-mcp/2.0.0';
    if (this.config.cfOriginSecret) {
      headers['X-Origin-Verify'] = this.config.cfOriginSecret;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    log('debug', 'api_request', { method, path, requestId });

    const response = await fetch(url, init);

    if (!response.ok) {
      const errorText = await response.text();
      log('warn', 'api_error', { method, path, status: response.status, requestId });
      throw new ApiError(response.status, errorText, path);
    }

    return response.json() as Promise<T>;
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`API ${path}: ${status} — ${body.slice(0, 200)}`);
    this.name = 'ApiError';
  }
}
