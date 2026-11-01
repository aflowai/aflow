/**
 * The channel lane's operations (Plan 327): a message to the operator, served by
 * an optional app that reaches them away from the machine. A message may carry
 * an Action Center item as a card the operator decides from (D3).
 *
 * No input names a recipient. The recipient is the person the run works for,
 * read from the job's `credentialOwnerId`, and the app serves only the operator
 * linked at its setup. An agent that could choose a recipient would hold an
 * exfiltration path and a spam path.
 */
import { z } from 'zod';
import type { OperationRegistration } from '../catalog/operationCatalog.js';

/**
 * Slack truncates a message's text past 40,000 characters, which is the limit
 * a longer one would break on.
 */
export const CHANNEL_MESSAGE_TEXT_MAX = 40_000;

export const ChannelMessageSendInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, 'text is empty. Write what the operator must read and do.')
      .max(CHANNEL_MESSAGE_TEXT_MAX)
      .describe(
        'What the operator reads on their phone. Say what waits on them and what they must do.',
      ),
    itemId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "An open Action Center item in this run's space, sent as a card under the text. The card " +
          'offers buttons only where the operator may decide the item from the phone.',
      ),
  })
  .strict();
export type ChannelMessageSendInput = z.infer<typeof ChannelMessageSendInputSchema>;

export const ChannelMessageSendOutputSchema = z.object({
  delivered: z.literal(true).describe('The channel accepted the message.'),
  messageRef: z
    .string()
    .min(1)
    .describe(
      'The posted message, as the channel names it. A retry of this step returns the same one.',
    ),
});
export type ChannelMessageSendOutput = z.infer<typeof ChannelMessageSendOutputSchema>;

export const CHANNEL_MESSAGE_SEND_OPERATION_ID = 'channel.message.send';

export const ChannelOperationRegistrations: OperationRegistration[] = [
  {
    stepType: 'channel',
    group: 'message',
    verb: 'send',
    name: 'Message the Operator',
    actionLabel: 'Messaging the operator…',
    groupDisplayName: 'Messages to the operator',
    groupDescription:
      'Send the operator a message on the channel they linked, such as Slack, so it reaches them away from the machine.',
    semanticDescription:
      'Send a text message to the operator on the channel they linked, such as Slack on their phone. ' +
      'The recipient is the person this run works for, never chosen. Use it when the operator must act and may be away from the machine.',
    tags: ['channel', 'message', 'notification', 'slack', 'operator'],
    idempotency: 'idempotent',
    mutates: true,
    accessMode: 'write',
    riskModifiers: ['external_side_effect'],
    usage: {
      oneLine: 'Message the operator on their linked channel, such as Slack.',
      minimalExampleInput: {
        text: 'The deploy skill waits on your approval of the production push. Open Aflow to approve or deny it.',
      },
      whenToUse: ['the operator must act and may be away from the machine'],
      whenNotToUse: [
        'progress reports nobody asked for',
        'Asking the operator something in this conversation they are already reading — answer them here',
      ],
      pitfalls: [
        'The message goes to the person this run works for, and only when they linked Slack with `yarn channel:slack setup`. Any other run fails.',
        'Sending the same text with the same `itemId` twice in one run fails, and so does the same text twice with no `itemId`. Say something new, or stop.',
        'The send is synchronous: a result means the channel accepted the message, not that the operator read it.',
        'An `itemId` must name an open item in this space. Buttons appear only for an approval or a simple question from a paused step, or a low or medium API write approval. Every other item tells the operator to open Aflow.',
      ],
    },
    inputZod: ChannelMessageSendInputSchema,
    outputZod: ChannelMessageSendOutputSchema,
  },
];
