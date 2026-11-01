/**
 * A reply's text arrives in Slack's wire encoding, and the paused step must
 * receive it as the operator typed it.
 */
import { describe, expect, it } from 'vitest';

import { typedTextOf } from '../slackText.js';

describe('typedTextOf', () => {
  it('reads the escaped &, < and > back as typed', () => {
    expect(typedTextOf('R&amp;D &lt;final&gt; a &amp;lt; b')).toBe('R&D <final> a &lt; b');
  });

  it('reads a link back as typed, with or without a scheme', () => {
    expect(typedTextOf('<https://example.com/a?b=1&amp;c=2>')).toBe(
      'https://example.com/a?b=1&c=2',
    );
    expect(typedTextOf('see <http://example.com|example.com>')).toBe('see example.com');
    expect(typedTextOf('<mailto:ops@example.com|ops@example.com>')).toBe('ops@example.com');
  });

  it('keeps the address of a link whose label differs from it', () => {
    expect(typedTextOf('<https://example.com/run/1|the run>')).toBe(
      'the run (https://example.com/run/1)',
    );
  });

  it('reads mentions, channel links and broadcasts back as references', () => {
    expect(typedTextOf('ask <@U024BE7LH>')).toBe('ask @U024BE7LH');
    expect(typedTextOf('ask <@U024BE7LH|alice>')).toBe('ask @alice');
    expect(typedTextOf('in <#C024BE7LR|general> and <#C024BE7LS>')).toBe(
      'in #general and #C024BE7LS',
    );
    expect(typedTextOf('<!here> <!channel> <!subteam^S012|@ops>')).toBe('@here @channel @ops');
  });

  it('leaves text with no encoding as it is', () => {
    expect(typedTextOf('v1.4.0 — "final"')).toBe('v1.4.0 — "final"');
  });
});
