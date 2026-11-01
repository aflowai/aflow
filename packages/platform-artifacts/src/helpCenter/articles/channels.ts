import type { HelpArticleInput } from '@aflow/schemas';

export const CHANNELS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'slack-channel',
    theme: 'integrations',
    question: 'How do I reach Aflow from Slack, so it can tell me when I must act?',
    summary:
      'Set up the Slack channel app from your aflow checkout with `yarn channel:slack setup`, restart the stack, start the app with `yarn channel:slack start`, and send the code setup prints to the bot in a Slack direct message. From then on an agent can send you a Slack message when you must act and may be away from the machine. Messages go only to you, the person the run works for. A message can carry an Action Center item as a card, and some cards can be decided from their buttons. Talking to Aflow from Slack comes in a later release.',
    body: `**Where:** a terminal in your aflow checkout, and Slack on any device

## What it does

An agent can send you a Slack message when you must act and may be away from the machine — a run that waits on your approval, for example. The message goes to you, the person the run works for. An agent cannot choose anyone else. The same text is sent once per run; sending it again fails.

## Deciding from a card

An agent can send an Action Center item with its message. It arrives as a card under the text. Some cards can be decided from Slack:

- **An approval a run is paused on** shows **Approve** and **Deny**.
- **A question a run is paused on** shows a button per answer when it asks for yes or no or for one of a few choices. When it asks for text, reply in the card's thread, and your reply is the answer as you typed it. A mention of a person arrives as their Slack member ID, such as \`@U024BE7LH\`.
- **An API write that waits on your approval**, at the low or medium risk tier, shows **Approve** and **Deny** with the call: its method, its host and the request body with secrets removed.

Every other card shows no buttons and says it needs you at Aflow. That includes a high-risk write, a browser action, a plan decision and a question the Helmsman asks about the plan. Open the Action Center in Aflow to decide those.

A tap decides the item as the Action Center would, and the card then says what you decided. If the item was already decided, the app says so and the tap changes nothing. If Aflow does not take a text answer, the app says why in the thread and the item stays open, so you can reply again. If Aflow could not be reached, the app says nothing was decided, and you can try again. If the app cannot tell whether your decision reached Aflow, it says the item may already be decided. Open the item in the Action Center and check it before you answer again. A reply in the thread of a card with buttons decides nothing, even "yes". Tap the button instead.

Talking to Aflow from Slack comes in a later release.

## 1. Create the Slack app

At api.slack.com/apps, create an app in your Slack workspace, then:

1. Under **Socket Mode**, turn it on and create an app-level token with the \`connections:write\` scope. It starts with \`xapp-\`.
2. Under **OAuth & Permissions**, add the bot scopes \`chat:write\`, \`im:write\` and \`im:history\`.
3. Under **Event Subscriptions**, turn events on and subscribe the bot to \`message.im\`.
4. Under **App Home**, allow users to send messages from the messages tab.
5. Under **Interactivity & Shortcuts**, turn interactivity on, so a card's buttons reach the app. With Socket Mode on, it needs no request URL.
6. Install the app to the workspace and copy the bot token. It starts with \`xoxb-\`.

## 2. Run setup

With the stack running (\`yarn start\`), run this from your aflow checkout:

\`\`\`bash
yarn channel:slack setup
\`\`\`

It asks for the two tokens, or reads \`SLACK_BOT_TOKEN\` and \`SLACK_APP_TOKEN\` from the environment. Then it:

- writes \`~/.aflow/channel-slack.env\`, readable only by you;
- creates an API key named **aflow Slack channel** for the instance owner. It expires after a year and is listed under **Settings → API Keys**. The app uses it to read the items it sends as cards and to decide them when you tap;
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
      'card',
      'approve',
    ],
  },
];
