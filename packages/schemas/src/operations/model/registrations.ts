import type { OperationRegistration } from '../../catalog/operationCatalog.js';
import {
  ModelRuntimeChangeInputSchema,
  ModelRuntimeChangeOutputSchema,
  ModelRuntimeStatusInputSchema,
  ModelRuntimeStatusOutputSchema,
} from './schemas.js';

/**
 * Plan 323 D10 — Helmsman reads the model runtime on this computer and asks
 * before changing it. Never a skill's (`isLocalModelOperation`): a run does not
 * reconfigure the machine it runs on.
 */
export const ModelOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'model',
    group: 'runtime',
    verb: 'status',
    name: 'Model Runtime Status',
    actionLabel: 'Checking the models on this computer…',
    groupDisplayName: 'Models on this computer',
    groupDescription:
      'The model runtime on the operator’s machine: what it has downloaded and loaded, how it fits the machine, and what is wrong with it.',
    semanticDescription:
      'Read the diagnosis of the space’s models on this computer: whether Ollama answers, each model’s fit to the machine and what is loaded — how much of it is on the GPU — and every issue with the numbers behind it and its remedy. Reading loads nothing.',
    tags: ['model', 'local', 'ollama', 'diagnostics', 'slow'],
    idempotency: 'idempotent',
    mutates: false,
    usage: {
      oneLine: 'Why the model on this computer is slow or not answering, and what fixes it.',
      whenToUse: [
        'The operator asks why responses are slow, or why the model is not answering',
        'Before proposing a change to the runtime, to propose the remedy an issue states',
      ],
      whenNotToUse: ['A model a hosted provider serves — this reads only the one on this computer'],
      pitfalls: [
        'Explain from the issue’s cause, which carries the numbers; propose its remedy as written',
      ],
      minimalExampleInput: {},
    },
    accessMode: 'read',
    inputZod: ModelRuntimeStatusInputSchema,
    outputZod: ModelRuntimeStatusOutputSchema,
  },
  {
    stepType: 'model',
    group: 'runtime',
    verb: 'change',
    name: 'Change Model Runtime',
    actionLabel: 'Asking to change the models on this computer…',
    semanticDescription:
      'Propose a change to the model runtime on this computer — download, delete, load or unload a model, or set the window its requests get. The operator approves it on a card first, which says what it costs and which requests in flight it ends; nothing changes until they do.',
    tags: ['model', 'local', 'ollama', 'pull', 'unload', 'context'],
    idempotency: 'non_idempotent',
    mutates: true,
    usage: {
      oneLine: 'Propose an issue’s remedy for the operator to approve.',
      whenToUse: ['model.runtime.status names an issue whose remedy is an action'],
      whenNotToUse: [
        'A remedy that assigns a role’s model (`use_for_every_role`) — that is the operator’s, under Settings → Agents; say so instead',
      ],
      pitfalls: [
        'Unloading or switching the model this conversation runs on makes its next turn load it again, a pause of up to a minute',
      ],
      minimalExampleInput: { change: { action: 'unload', model: 'ollama-gemma4-26b' } },
    },
    accessMode: 'write',
    inputZod: ModelRuntimeChangeInputSchema,
    outputZod: ModelRuntimeChangeOutputSchema,
  },
];
