import { describe, expect, it } from 'vitest';
import {
  isInlineOperation,
  isWorkflowTaskSafeInlineOperation,
  WORKFLOW_TASK_SAFE_INLINE_OPERATION_IDS,
} from '../inlineOperations.js';

/**
 * The workflow-task safelist names operations the dispatcher may run inline as
 * a task. An entry that `isInlineOperation` does not also claim is never
 * reached: the step is dispatched to an executor for its stepType, and fails
 * with "No executor available" at run time rather than at authoring time.
 */
describe('the workflow-task safelist cannot name a non-inline operation', () => {
  for (const operationId of WORKFLOW_TASK_SAFE_INLINE_OPERATION_IDS) {
    it(`${operationId} is routed inline`, () => {
      expect(isWorkflowTaskSafeInlineOperation(operationId)).toBe(true);
      expect(isInlineOperation(operationId)).toBe(true);
    });
  }
});
