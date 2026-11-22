/**
 * `space.autonomy.update` — the Helmsman's write of its own space's autonomy
 * setting (Plan 345 D), on the path `PUT /v1/spaces/:spaceId/autonomy` takes.
 * It writes only the calling space, and only for a session whose user is an
 * admin of it, as the route requires.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  ResolvedSpaceAutonomyPolicySchema,
  SpaceAutonomyPolicySchema,
  SpaceAutonomySchema,
  SpaceStoreUpdatesSchema,
} from '../models/spaceAutonomy.js';

export const SPACE_AUTONOMY_UPDATE_OPERATION_ID = 'space.autonomy.update';

export const SpaceAutonomyUpdateInputSchema = z
  .object({
    autonomy: SpaceAutonomySchema.optional(),
    storeUpdates: SpaceStoreUpdatesSchema.optional(),
  })
  .strict()
  .refine((input) => input.autonomy !== undefined || input.storeUpdates !== undefined, {
    message: 'Name `autonomy`, `storeUpdates` or both. A field left out keeps its stored value.',
  });
export type SpaceAutonomyUpdateInput = z.infer<typeof SpaceAutonomyUpdateInputSchema>;

export const SpaceAutonomyUpdateOutputSchema = z.object({
  autonomyPolicy: SpaceAutonomyPolicySchema.nullable().describe(
    'The setting as stored now, the value `GET /v1/spaces/:spaceId/autonomy` returns under the same key.',
  ),
  resolved: ResolvedSpaceAutonomyPolicySchema.describe(
    'The setting as every reader sees it, each default filled in.',
  ),
});
export type SpaceAutonomyUpdateOutput = z.infer<typeof SpaceAutonomyUpdateOutputSchema>;

export const SpaceAutonomyOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'space',
    group: 'autonomy',
    verb: 'update',
    name: 'Update Space Autonomy',
    actionLabel: 'Setting the space’s autonomy…',
    semanticDescription:
      'Write this space’s autonomy setting, on the path `PUT /v1/spaces/:spaceId/autonomy` takes. ' +
      'It writes only the space the conversation runs in, and only where the session’s user is an ' +
      'admin of that space. A field named replaces its stored value, and a field left out keeps it.',
    tags: ['space', 'autonomy', 'policy'],
    idempotency: 'idempotent',
    mutates: true,
    usage: {
      oneLine: 'Set this space’s autonomy to `full` or `ratify`, and its Store updates.',
      whenToUse: [
        'The operator has said this space should act without asking, or ask first: write `autonomy` to match their word.',
        'The operator wants Store updates applied on their own, or only by hand: write `storeUpdates`.',
      ],
      whenNotToUse: [
        'Another space — the op writes only the space this conversation runs in.',
        'Reading the setting — the space context’s `autonomy` section carries it on every turn.',
      ],
      pitfalls: [
        'Write it on the operator’s word only. A space under `ratify` asks first because its operator chose that.',
        'Refused with a `permission` error where the session’s user is not an admin of the space. Tell the operator which space and why.',
        'The space context moves at once. The next turn reads the new setting.',
      ],
      minimalExampleInput: { autonomy: 'full' },
      followUp: [
        {
          operationId: 'channel.message.send',
          note: 'Tell the operator which setting the space holds now.',
        },
      ],
    },
    accessMode: 'write',
    inputZod: SpaceAutonomyUpdateInputSchema,
    outputZod: SpaceAutonomyUpdateOutputSchema,
  },
];
