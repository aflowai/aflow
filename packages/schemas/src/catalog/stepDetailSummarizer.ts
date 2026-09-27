/**
 * Step detail summarizer — extracts a short, content-focused detail string
 * from a step's resolved input for display in activity rows and timelines.
 *
 * Each operation can register an extractor that picks out the most meaningful
 * field(s) from the input and returns a human-readable summary (max ~80 chars).
 *
 * When no extractor is registered or the input lacks the expected fields,
 * returns undefined — the UI falls back gracefully to the existing labels.
 */

const MAX_DETAIL_LENGTH = 80;

/**
 * Truncate a string to a maximum length, adding an ellipsis if needed.
 */
function truncate(value: string, max: number = MAX_DETAIL_LENGTH): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

/**
 * Safely extract a string value from a nested path (e.g., 'target.path').
 */
function str(input: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let current: unknown = input;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

/**
 * Extract the last path segment (filename or leaf) from a path-like string.
 */
function leafName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

// ============================================================================
// Per-operation detail extractors
// ============================================================================

type DetailExtractor = (input: Record<string, unknown>) => string | undefined;

const EXTRACTORS: Record<string, DetailExtractor> = {
  // ── Memory ──────────────────────────────────────────────────────────────
  'memory.store.get': (input) => {
    const path = str(input, 'target.path');
    const id = str(input, 'target.id');
    const view = str(input, 'view');
    const target = path ? leafName(path) : id;
    if (!target) return undefined;
    if (view && view !== 'stat') return truncate(`${target} (${view})`);
    return truncate(target);
  },

  'memory.store.query': (input) => {
    const mode = str(input, 'mode');
    const query = str(input, 'query');
    const pathPrefix = str(input, 'pathPrefix');
    if (query) return truncate(`"${query}"`);
    if (pathPrefix) return truncate(pathPrefix);
    if (mode) return mode;
    return undefined;
  },

  'memory.store.put': (input) => {
    const path = str(input, 'path');
    if (path) return truncate(leafName(path));
    return undefined;
  },

  'memory.store.patch': (input) => {
    const path = str(input, 'target.path');
    const id = str(input, 'target.id');
    const target = path ? leafName(path) : id;
    if (target) return truncate(target);
    return undefined;
  },

  'memory.store.delete': (input) => {
    const path = str(input, 'target.path');
    const id = str(input, 'target.id');
    const target = path ? leafName(path) : id;
    if (target) return truncate(target);
    return undefined;
  },

  'memory.store.mkdir': (input) => {
    const path = str(input, 'path');
    if (path) return truncate(path);
    return undefined;
  },

  // ── API ─────────────────────────────────────────────────────────────────
  'api.http.call': (input) => {
    const apiId = str(input, 'apiId');
    const endpointId = str(input, 'endpointId');
    const url = str(input, 'url');
    const method = str(input, 'method');
    if (apiId && endpointId) return truncate(`${apiId} → ${endpointId}`);
    if (apiId) return truncate(apiId);
    if (url) {
      const prefix = method ? `${method.toUpperCase()} ` : '';
      try {
        const u = new URL(url);
        return truncate(`${prefix}${u.hostname}${u.pathname}`);
      } catch {
        return truncate(`${prefix}${url}`);
      }
    }
    return undefined;
  },

  // ── Search ──────────────────────────────────────────────────────────────
  'search.web.search': (input) => {
    const query = str(input, 'query');
    if (query) return truncate(`"${query}"`);
    return undefined;
  },

  'search.web.fetch': (input) => {
    const url = str(input, 'url');
    if (url) {
      try {
        const u = new URL(url);
        return truncate(`${u.hostname}${u.pathname}`);
      } catch {
        return truncate(url);
      }
    }
    return undefined;
  },

  // ── AI ──────────────────────────────────────────────────────────────────
  'ai.text.generate': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ai.text.generate_json': (input) => {
    const schemaName = str(input, 'schemaName');
    const prompt = str(input, 'prompt');
    if (schemaName) return truncate(schemaName);
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ai.text.generate_stream': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ai.media.image': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ai.media.edit_image': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ai.media.video': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  // ── Compute ─────────────────────────────────────────────────────────────
  'compute.sandbox.exec': (input) => {
    const runtime = str(input, 'runtime');
    const entryPoint = str(input, 'entryPoint');
    if (entryPoint) return truncate(`${runtime ?? 'code'} → ${entryPoint}`);
    if (runtime) return runtime;
    return undefined;
  },

  // ── Agent control ───────────────────────────────────────────────────────
  'agent.control.delegate': (input) => {
    const flowId = str(input, 'flowId');
    if (flowId) return truncate(flowId);
    return undefined;
  },

  'agent.control.dispatch': (input) => {
    const targetStepId = str(input, 'targetStepId');
    if (targetStepId) return truncate(`→ ${targetStepId}`);
    return undefined;
  },

  'agent.control.abort': (input) => {
    const reason = str(input, 'reason');
    if (reason) return truncate(reason);
    return undefined;
  },

  // ── User interaction ────────────────────────────────────────────────────
  'user.interaction.ask': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'user.interaction.approve': (input) => {
    const title = str(input, 'title');
    if (title) return truncate(title);
    return undefined;
  },

  // ── MCP ─────────────────────────────────────────────────────────────────
  'mcp.tool.call': (input) => {
    const toolName = str(input, 'toolName');
    const serverUrl = str(input, 'serverUrl');
    if (toolName) return truncate(toolName);
    if (serverUrl) {
      try {
        return truncate(new URL(serverUrl).hostname);
      } catch {
        return truncate(serverUrl);
      }
    }
    return undefined;
  },

  'mcp.tool.list': (input) => {
    const serverUrl = str(input, 'serverUrl');
    if (serverUrl) {
      try {
        return truncate(new URL(serverUrl).hostname);
      } catch {
        return truncate(serverUrl);
      }
    }
    return undefined;
  },

  // ── UI ──────────────────────────────────────────────────────────────────
  'ui.artifact.generate': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  'ui.surface.visualize': (input) => {
    const prompt = str(input, 'prompt');
    if (prompt) return truncate(`"${prompt}"`);
    return undefined;
  },

  // ── Agent manage (CRUD) ─────────────────────────────────────────────────
  'agent.manage.create': (input) => {
    const name = str(input, 'name');
    if (name) return truncate(name);
    return undefined;
  },

  'agent.manage.get': (input) => {
    const flowId = str(input, 'flowId');
    if (flowId) return truncate(flowId);
    return undefined;
  },

  'agent.manage.update': (input) => {
    const flowId = str(input, 'flowId');
    if (flowId) return truncate(flowId);
    return undefined;
  },

  'agent.manage.delete': (input) => {
    const flowId = str(input, 'flowId');
    if (flowId) return truncate(flowId);
    return undefined;
  },

  'api.definition.get': (input) => {
    const apiId = str(input, 'apiId');
    if (apiId) return truncate(apiId);
    return undefined;
  },

  'api.definition.upsert': (input) => {
    const name = str(input, 'name');
    if (name) return truncate(name);
    return undefined;
  },

  'api.definition.import_openapi': (input) => {
    const name = str(input, 'name');
    if (name) return truncate(name);
    return undefined;
  },

  'user.notification.email': (input) => {
    const subject = str(input, 'subject');
    if (subject) return truncate(subject);
    return undefined;
  },
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract a short, content-focused detail string from a step's resolved input.
 *
 * Returns undefined when no meaningful detail can be extracted — the caller
 * should fall back to existing generic labels.
 */
export function summarizeStepInput(
  operationId: string,
  input: Record<string, unknown>,
): string | undefined {
  const extractor = EXTRACTORS[operationId];
  if (!extractor) return undefined;
  try {
    return extractor(input);
  } catch {
    // Never let a summarizer failure break scheduling
    return undefined;
  }
}
