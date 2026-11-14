/** The Slack client's reaction call: the method, the token and the body Slack reads. */
import { describe, expect, it } from 'vitest';

import { SlackApiError, createSlackClient } from '../slack.js';

function clientAnswering(answer: Record<string, unknown>) {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const slack = createSlackClient({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    fetchImpl: (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return Promise.resolve(Response.json(answer));
    },
  });
  return { slack, calls };
}

describe('addReaction', () => {
  it('calls reactions.add with the bot token, the channel and the message timestamp', async () => {
    const { slack, calls } = clientAnswering({ ok: true });

    await slack.addReaction('D-1', '1700000000.000100', 'eyes');

    expect(calls).toEqual([
      {
        url: 'https://slack.com/api/reactions.add',
        authorization: 'Bearer xoxb-test',
        body: { channel: 'D-1', timestamp: '1700000000.000100', name: 'eyes' },
      },
    ]);
  });

  it('rejects with the error Slack answers', async () => {
    const { slack } = clientAnswering({ ok: false, error: 'missing_scope' });

    await expect(slack.addReaction('D-1', '1.0', 'eyes')).rejects.toEqual(
      new SlackApiError('reactions.add', 'missing_scope', false),
    );
  });
});
