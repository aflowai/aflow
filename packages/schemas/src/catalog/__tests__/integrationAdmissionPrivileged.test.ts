/**
 * Contract: a host enters a space through its operator, never through an agent.
 *
 * The tenant integration allowlist is not what carries this. It defaults to
 * `open` and stays there on a single-owner instance, where an allowlist would
 * only gate the one principal who is already the trust boundary. What keeps an
 * agent off a host nobody declared is that changing an API or MCP definition or
 * binding is a privileged operation, and grant enforcement refuses those to an
 * agent-driven run.
 *
 * The marking is therefore load-bearing rather than administrative tidiness.
 * Clearing it lets an agent mint the binding that reaches wherever it likes,
 * complete the consent that gives that binding live credentials, or re-read a
 * remote server's tool list — with no allowlist behind any of it to catch the
 * result.
 */
import { describe, expect, it } from 'vitest';
import { getAllOperations } from '../registry.js';

/** Where a host is named: the definition, the binding, or the server entry. */
const HOST_BEARING_GROUPS = new Set(['definition', 'binding', 'server']);

const READ_VERBS = new Set(['get', 'list']);

/**
 * `api.binding.test` probes a binding and changes nothing. Its MCP namesake
 * pins the origin and rewrites the cached tool list, which is why the registry
 * marks that one privileged and this one not — the verb is the same and the
 * authority is not.
 */
const PROBES_WITHOUT_WRITING = new Set(['api.binding.test']);

describe('integration host admission is operator-only', () => {
  const admitting = [...getAllOperations().values()].filter((op) => {
    const [stepType, group, verb] = op.operationId.split('.');
    if (stepType !== 'api' && stepType !== 'mcp') return false;
    if (group === undefined || !HOST_BEARING_GROUPS.has(group)) return false;
    if (verb === undefined || READ_VERBS.has(verb)) return false;
    return !PROBES_WITHOUT_WRITING.has(op.operationId);
  });

  it('finds the operations that reach a host', () => {
    // Every group above contributes at least its upsert, so a filter that
    // stopped matching would show up here rather than as a vacuous pass.
    expect(admitting.length).toBeGreaterThanOrEqual(HOST_BEARING_GROUPS.size);
  });

  it('marks every one of them privileged', () => {
    const unprivileged = admitting
      .filter((op) => op.privileged !== true)
      .map((op) => op.operationId)
      .sort();
    expect(unprivileged).toEqual([]);
  });
});
