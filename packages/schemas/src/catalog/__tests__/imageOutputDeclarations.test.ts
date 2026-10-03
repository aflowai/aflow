/**
 * Contract: an operation whose data comes from outside the platform does not
 * declare image outputs unless it is named here, with a reason.
 *
 * A declared image's reference is read by the executor and its bytes sent to
 * the model. The orchestrator carries only a reference the producing step
 * itself stored, but an operation passing through an HTTP response, an MCP
 * tool result or sandboxed code output stores whatever that source handed it —
 * so the declaration is where the decision to trust such a source is made, and
 * it is made here in review rather than in a registration nobody re-reads.
 */
import { describe, expect, it } from 'vitest';
import type { OperationDescriptor } from '../operationCatalog.js';
import { getAllOperations } from '../registry.js';

/** Step types whose output carries data that originates outside the platform. */
const EXTERNAL_DATA_STEP_TYPES = new Set(['api', 'mcp', 'compute', 'search', 'memory']);

/** operationId → why this operation's images may be shown although its data is external. */
const EXTERNAL_IMAGE_OUTPUT_ALLOWLIST: Readonly<Record<string, string>> = {};

function unallowedExternalImageDeclarations(
  operations: Iterable<Pick<OperationDescriptor, 'operationId' | 'stepType' | 'imageOutputPaths'>>,
  allowlist: Readonly<Record<string, string>>,
): string[] {
  const offenders: string[] = [];
  for (const op of operations) {
    if (op.imageOutputPaths === undefined) continue;
    if (!EXTERNAL_DATA_STEP_TYPES.has(op.stepType)) continue;
    if (Object.hasOwn(allowlist, op.operationId)) continue;
    offenders.push(op.operationId);
  }
  return offenders;
}

describe('image output declarations', () => {
  it('no external-data operation declares image outputs unless allowlisted', () => {
    expect(
      unallowedExternalImageDeclarations(
        getAllOperations().values(),
        EXTERNAL_IMAGE_OUTPUT_ALLOWLIST,
      ),
    ).toEqual([]);
  });

  it('every allowlisted operation exists, declares image outputs, and gives a reason', () => {
    const operations = getAllOperations();
    for (const [operationId, reason] of Object.entries(EXTERNAL_IMAGE_OUTPUT_ALLOWLIST)) {
      const op = operations.get(operationId);
      expect(op?.imageOutputPaths, operationId).toBeDefined();
      expect(EXTERNAL_DATA_STEP_TYPES.has(op!.stepType), operationId).toBe(true);
      expect(reason.trim().length, operationId).toBeGreaterThan(0);
    }
  });

  it('catches an external-data operation that declares image outputs', () => {
    const fixtures = [...EXTERNAL_DATA_STEP_TYPES].map((stepType) => ({
      operationId: `${stepType}.fixture.capture`,
      stepType,
      imageOutputPaths: ['image'],
    }));
    expect(unallowedExternalImageDeclarations(fixtures, {})).toEqual(
      fixtures.map((f) => f.operationId),
    );
    expect(
      unallowedExternalImageDeclarations(
        [
          {
            operationId: 'browser.page.screenshot',
            stepType: 'browser',
            imageOutputPaths: ['image'],
          },
        ],
        {},
      ),
    ).toEqual([]);
  });
});
