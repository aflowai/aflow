/**
 * `space.autonomy.update` — the Helmsman's write of its own space's autonomy
 * setting (Plan 345 D), on the path `PUT /v1/spaces/:spaceId/autonomy` takes.
 * It writes only the calling space, and only for a session whose user is an
 * admin of it, as the route requires. A raise from `ratify` to `full` also
 * needs a message of the operator's in the space's conversation record, one
 * no earlier raise has spent.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';
import {
  ResolvedSpaceAutonomyPolicySchema,
  SpaceAutonomyPolicySchema,
  SpaceAutonomySchema,
  SpaceStoreUpdatesSchema,
} from '../models/spaceAutonomy.js';
import { ROOM_MESSAGE_MAX_LENGTH } from '../runtime/roomMessage.js';

export const SPACE_AUTONOMY_UPDATE_OPERATION_ID = 'space.autonomy.update';

export const SpaceAutonomyUpdateInputSchema = z
  .object({
    autonomy: SpaceAutonomySchema.optional(),
    storeUpdates: SpaceStoreUpdatesSchema.optional(),
    directiveQuote: z
      .string()
      .trim()
      .min(3)
      .max(ROOM_MESSAGE_MAX_LENGTH)
      .optional()
      .describe(
        'Only with `autonomy: "full"` on a space under `ratify`: the whole of a message the operator sent you ' +
          'in a conversation of this space, verbatim, never a part of it. The message must name "full" and "autonomy" ' +
          'and hold no word that negates or reverses the raise, such as "not", "don’t", "stop" or "ratify". ' +
          'The op finds the message in the conversation record and verifies its author.',
      ),
  })
  .strict()
  .refine((input) => input.autonomy !== undefined || input.storeUpdates !== undefined, {
    message: 'Name `autonomy`, `storeUpdates` or both. A field left out keeps its stored value.',
  })
  .refine((input) => input.directiveQuote === undefined || input.autonomy === 'full', {
    message: '`directiveQuote` goes only with `autonomy: "full"`, the raise it authorises.',
    path: ['directiveQuote'],
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
      'admin of that space. A field named replaces its stored value, and a field left out keeps it. ' +
      'A raise from `ratify` to `full` is written only on a message the operator sent in a conversation of this space, ' +
      'which `directiveQuote` quotes whole and which asks for full autonomy. The op verifies the platform recorded it with an admin of the space as its author. ' +
      'The write records it as spent, so each raise needs a message recorded after the last one spent.',
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
        'A raise from `ratify` to `full` is refused with a `permission` error without `directiveQuote`. Quote the operator’s whole message, not a part of it and not your summary of it.',
        'A message that does not name "full" and "autonomy", such as "yes", or one that refuses the raise, such as "please do not set full autonomy", is refused. Ask the operator to say it in one message.',
        'Your own words, a plan document or a delegated session’s prompt are not the operator’s message, and the op refuses them.',
        'Each raise spends the message it cites. After a lowering, a raise needs a new message from the operator.',
        'A lowering to `ratify`, or a change of `storeUpdates` alone, needs no directive.',
        'Refused with a `permission` error where the session’s user is not an admin of the space. Tell the operator which space and why.',
        'The space context moves at once. The next turn reads the new setting.',
      ],
      minimalExampleInput: {
        autonomy: 'full',
        directiveQuote: 'Full autonomy please, nothing waits on me.',
      },
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
