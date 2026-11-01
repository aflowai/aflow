import type { HelpArticleInput } from '@aflow/schemas';

export const CHANNELS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'slack-channel',
    theme: 'integrations',
    question: 'How do I reach Aflow from Slack, so it can tell me when I must act?',
    summary:
      'Set up the Slack channel app from your aflow checkout with `yarn channel:slack setup`, restart the stack, start the app with `yarn channel:slack start`, and send the code setup prints to the bot in a Slack direct message. From then on an agent can send you a Slack message when you must act and may be away from the machine. Messages go only to you, the person the run works for. Answering from Slack and approving from a card come in a later release.',
    body: `**Where:** a terminal in your aflow checkout, and Slack on any device

## What it does

An agent can send you a Slack message when you must act and may be away from the machine — a run that waits on your approval, for example. The message goes to you, the person the run works for. An agent cannot choose anyone else. The same text is sent once per run; sending it again fails.

In this release Slack only receives. To act on a message, open Aflow. Answering from Slack and approving from a card come later.

## 1. Create the Slack app

At api.slack.com/apps, create an app in your Slack workspace, then:

1. Under **Socket Mode**, turn it on and create an app-level token with the \`connections:write\` scope. It starts with \`xapp-\`.
2. Under **OAuth & Permissions**, add the bot scopes \`chat:write\`, \`im:write\` and \`im:history\`.
3. Under **Event Subscriptions**, turn events on and subscribe the bot to \`message.im\`.
4. Under **App Home**, allow users to send messages from the messages tab.
5. Install the app to the workspace and copy the bot token. It starts with \`xoxb-\`.

## 2. Run setup

With the stack running (\`yarn start\`), run this from your aflow checkout:

\`\`\`bash
yarn channel:slack setup
\`\`\`

It asks for the two tokens, or reads \`SLACK_BOT_TOKEN\` and \`SLACK_APP_TOKEN\` from the environment. Then it:

- writes \`~/.aflow/channel-slack.env\`, readable only by you;
- creates an API key named **aflow Slack channel** for the instance owner. It expires after a year and is listed under **Settings → API Keys**;
- gives the stack a credential for the channel, so the stack offers the operation once it restarts;
- prints a one-time code, good for 30 minutes.

## 3. Restart and start the app

Restart the stack with \`yarn start\`. Then start the app and keep it running:

\`\`\`bash
yarn channel:slack start
\`\`\`

## 4. Link your Slack account

Send the code to the bot in a direct message. The bot answers **Linked**. The Slack account that sends the code is the only one the app serves from then on. Anyone else who messages the bot gets one fixed reply, and their message is not kept.

To link another account, run setup again, then restart the app: stop \`yarn channel:slack start\` and start it again. The app reads the code when it starts, so until it restarts it refuses the new code. Then send the new code from that account.

## When a message is not sent

- **The operation is not offered at all.** The stack has no channel credential, or has not restarted since setup. Run setup, then restart.
- **The send fails and names \`yarn channel:slack setup\`.** The run works for someone other than the linked operator, or nobody has linked yet. Send the code from Slack. A code from a later setup run works only once the app has restarted.
- **The step waits for the channel app.** The app is not running. Start it with \`yarn channel:slack start\`.

## Removing it

Stop the app and delete \`~/.aflow/channel-slack.env\` and \`~/.aflow/channel-slack.store.json\`. Remove \`PHOENIX_CHANNEL_REDIS_PASSWORD\` from the instance file and restart the stack, and the operation is gone. Revoke the key under **Settings → API Keys**.`,
    editions: ['community-local'],
    anchors: {
      routes: [],
      operations: ['channel.message.send'],
    },
    related: ['local-edition-limits'],
    keywords: [
      'slack',
      'phone',
      'notification',
      'away',
      'channel',
      'socket mode',
      'message',
      'mobile',
    ],
  },
];
