import type { HelpArticleInput } from '@aflow/schemas';

export const CHANNELS_ARTICLES: readonly HelpArticleInput[] = [
  {
    id: 'slack-channel',
    theme: 'integrations',
    question: 'How do I reach Aflow from Slack, so it can tell me when I must act?',
    summary:
      'Set up the Slack channel app from your aflow checkout with `yarn channel:slack setup`, restart the stack, start the app with `yarn channel:slack start`, and send the code setup prints to the bot in a Slack direct message. From then on an agent can send you a Slack message when you must act and may be away from the machine. Messages go only to you, the person the run works for, and each names its space in brackets. A message can carry an Action Center item as a card, and some cards can be decided from their buttons. A reply under an agent’s message stays in that message’s space. A direct message to the bot starts a conversation with the Helmsman in the space it names, or else in the current space, and a reply in its thread continues it.',
    body: `**Where:** a terminal in your aflow checkout, and Slack on any device

## What it does

An agent can send you a Slack message when you must act and may be away from the machine — a run that waits on your approval, for example. The message goes to you, the person the run works for. An agent cannot choose anyone else. The same text is sent once per run; sending it again fails.

Every message opens with the name of the space that speaks, in brackets, such as **[Trading Joe]**. The Helmsman's answers and notes in a thread open with it too, so you always know which space is talking.

Reply in the thread under an agent's message to answer it, and the reply stays in that message's space. When the Helmsman sent the message from a conversation that waits for you, your reply continues that conversation. Otherwise it starts a Helmsman conversation in that space, which reads your reply, the run that sent the message and the message itself.

## Deciding from a card

An agent can send an Action Center item with its message. It arrives as a card under the text. Some cards can be decided from Slack:

- **An approval a run is paused on** shows **Approve** and **Deny**.
- **A question a run is paused on** shows a button per answer when it asks for yes or no or for one of a few choices. When it asks for text, reply in the card's thread, and your reply is the answer as you typed it. A mention of a person arrives as their Slack member ID, such as \`@U024BE7LH\`.
- **An API write that waits on your approval**, at the low or medium risk tier, shows **Approve** and **Deny** with the call: its method, its host and the request body with secrets removed.

Every other card shows no buttons and says it needs you at Aflow. That includes a high-risk write, a browser action, a plan decision and a question the Helmsman asks about the plan. Open the Action Center in Aflow to decide those.

A tap decides the item as the Action Center would, and the card then says what you decided. If the item was already decided, the app says so and the tap changes nothing. If the item changed at Aflow after the card was sent and is still open, the card says so and that it needs you at Aflow. A tap on a card the app no longer holds, such as one older than 30 days, decides nothing, and the app says so in its thread. If Aflow does not take a text answer, the app says why in the thread and the item stays open, so you can reply again. If Aflow could not be reached, the app says nothing was decided, and you can try again. If the app cannot tell whether your decision reached Aflow, it says the item may already be decided. Open the item in the Action Center and check it before you answer again. A reply in the thread of a card with buttons decides nothing, even "yes". Tap the button instead.

## Talking to the Helmsman

Send the bot a direct message, such as "status?" or "why did that fail?". It starts a conversation with the Helmsman in the direct message's current space. The Helmsman's answer arrives in the thread under your message, opened by that space's name in brackets. Reply in that thread to continue the same conversation. A new direct message, outside a thread, starts another one.

To reach another space, start a new direct message with the space's slug after \`#\` or \`@\`, or with its name and a colon: \`#trading-joe status?\`, \`@trading-joe status?\` or \`Trading Joe: status?\`. A slug must match exactly, and a name matches whatever its case. A space you cannot reach gets one reply that lists the spaces you can reach, and nothing is sent. A message that opens with a mention of a person, or with a number such as \`#1\`, is sent as you typed it. The space a message names becomes the current space, and so does the space whose answer last came to you. A message that names no space goes to the current space. Until there is one, it goes to your home space: the space Aflow opens first for you. Send \`spaces\` alone to list the spaces you can reach with their slugs, the current one marked. A reply inside a thread always stays in that thread's space, even when it starts with a space's name.

The Helmsman acts as you, with what your own account may do, and nothing more is granted for Slack. A reply in a conversation's thread is a message to the Helmsman. It decides no Action Center item, even "yes".

- **A message that arrives late is not sent at once.** When Slack delivers a message more than ten minutes after you sent it, the app asks "This arrived late. Run it now?" with **Run it now** and **Discard**. A message you run tells the Helmsman when you sent it.
- **Each message is sent once.** If Slack delivers a message twice, the second copy does nothing.
- **Send one message at a time in a thread.** A reply sent while the Helmsman is still answering is not sent, and the app says so.
- **The answer arrives whenever it is ready.** The thread waits for it with no time limit, and you do not need to reply to get it. When the app cannot read Aflow for several minutes, the thread stops waiting and says so. When the Helmsman has waited an hour on something that needs you at Aflow, such as an approval, the thread stops waiting too. So does a thread whose conversation shows nothing new at Aflow for six hours. A reply in the thread then looks again, and the answer comes there. The reply itself is not sent to the Helmsman, so send it again once the answer is here.
- **The thread follows the Helmsman as it works.** Each note the Helmsman writes while it works arrives as a message of its own. If it writes faster than the app can read, the thread says some notes are only at Aflow. When it starts work that runs at Aflow, such as a workflow run, the thread says so once.
- **When Aflow could not be reached,** the app says the Helmsman did not get your message, and you can send it again. When the app cannot tell whether it arrived, it says so. Check the conversation at Aflow before you send it again.
- **Messages sent while the app is not running are not recovered.**

## 1. Create the Slack app

At api.slack.com/apps, create an app in your Slack workspace, then:

1. Under **Socket Mode**, turn it on and create an app-level token with the \`connections:write\` scope. It starts with \`xapp-\`.
2. Under **OAuth & Permissions**, add the bot scopes \`chat:write\`, \`im:write\`, \`im:history\` and \`reactions:write\`.
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
- creates an API key named **aflow Slack channel** for the instance owner. It expires after a year and is listed under **Settings → API Keys**. The app uses it to read the items it sends as cards and to decide them when you tap. It reads the name of each space a message speaks for, and whether a Helmsman conversation sent it. It also holds your conversations with the Helmsman: it lists your spaces and finds your home space, starts and continues the conversation, and reads its answers;
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
      'helmsman',
      'conversation',
      'thread',
    ],
  },
];
