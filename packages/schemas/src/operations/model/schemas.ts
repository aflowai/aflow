import { z } from 'zod';
import { buildOperationId } from '../../catalog/operationId.js';
import {
  LocalRuntimeChangeSchema,
  LocalRuntimeDiagnosticsSchema,
} from '../../credentials/localRuntimeDiagnostics.js';

export const MODEL_RUNTIME_STATUS_OPERATION_ID = buildOperationId('model', 'runtime', 'status');
export const MODEL_RUNTIME_CHANGE_OPERATION_ID = buildOperationId('model', 'runtime', 'change');

export const ModelRuntimeStatusInputSchema = z.object({}).strict();

export const ModelRuntimeStatusOutputSchema = z.object({
  diagnostics: LocalRuntimeDiagnosticsSchema.nullable().describe(
    'The runtime, the machine, every model with its fit and what is loaded, and each issue with its cause and remedy. Null when the space has no Ollama connection.',
  ),
});

export const ModelRuntimeChangeInputSchema = z.object({
  change: LocalRuntimeChangeSchema.describe(
    "The change, as an issue's remedy states it — pass its `action` object unchanged. The operator approves it on a card before it runs.",
  ),
});

export const ModelRuntimeChangeOutputSchema = z.object({
  message: z.string().describe('What the runtime did.'),
});
