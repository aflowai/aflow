/**
 * An agent writes markdown, and Slack shows mrkdwn. Every message the agent
 * sends must read in Slack with no markdown left in sight.
 */
import { describe, expect, it } from 'vitest';

import { mrkdwnUnits, slackMrkdwnOf } from '../slackMrkdwn.js';

describe('slackMrkdwnOf', () => {
  it('turns every heading level into a bold line', () => {
    expect(slackMrkdwnOf('# Release')).toBe('*Release*');
    expect(slackMrkdwnOf('### Next steps ###')).toBe('*Next steps*');
    expect(slackMrkdwnOf('## The **final** plan')).toBe('*The final plan*');
    expect(slackMrkdwnOf('#hashtag stays')).toBe('#hashtag stays');
  });

  it('turns **bold** and __bold__ into *bold*', () => {
    expect(slackMrkdwnOf('a **strong** word')).toBe('a *strong* word');
    expect(slackMrkdwnOf('a __strong__ word')).toBe('a *strong* word');
    expect(slackMrkdwnOf('**one** and **two**')).toBe('*one* and *two*');
  });

  it('keeps italics as Slack italics', () => {
    expect(slackMrkdwnOf('an *emphasised* word')).toBe('an _emphasised_ word');
    expect(slackMrkdwnOf('an _emphasised_ word')).toBe('an _emphasised_ word');
    expect(slackMrkdwnOf('**bold with *italic* inside**')).toBe('*bold with _italic_ inside*');
    expect(slackMrkdwnOf('2*3*4 and snake_case_name')).toBe('2*3*4 and snake_case_name');
    expect(slackMrkdwnOf('~~gone~~')).toBe('~gone~');
  });

  it('keeps inline code as code, and reads nothing inside it as markup', () => {
    expect(slackMrkdwnOf('run `yarn test` now')).toBe('run `yarn test` now');
    expect(slackMrkdwnOf('`**not bold** <x> & [a](https://b.c)`')).toBe(
      '`**not bold** &lt;x&gt; &amp; [a](https://b.c)`',
    );
    expect(slackMrkdwnOf('``a ` b``')).toBe('`a ` b`');
  });

  it('turns a fenced block into a Slack code block, without its language', () => {
    expect(
      slackMrkdwnOf('Before\n```ts\nconst a = 1 < 2 && **b**;\n# not a heading\n```\nAfter'),
    ).toBe('Before\n```\nconst a = 1 &lt; 2 &amp;&amp; **b**;\n# not a heading\n```\nAfter');
    expect(slackMrkdwnOf('~~~\n- not a bullet\n~~~')).toBe('```\n- not a bullet\n```');
  });

  it('closes a block the text never closed', () => {
    expect(slackMrkdwnOf('```\nline one\nline two')).toBe('```\nline one\nline two\n```');
  });

  it('breaks up a ``` inside a block, which would end it early in Slack', () => {
    expect(slackMrkdwnOf('````\n```\n````')).toBe('```\n`\u200b``\n```');
  });

  it('turns [text](url) into <url|text>, and escapes the url', () => {
    expect(slackMrkdwnOf('see [the run](https://example.com/runs?id=7&tab=log)')).toBe(
      'see <https://example.com/runs?id=7&amp;tab=log|the run>',
    );
    expect(slackMrkdwnOf('[**docs**](https://example.com "Docs")')).toBe(
      '<https://example.com|docs>',
    );
    expect(slackMrkdwnOf('[](https://example.com)')).toBe('<https://example.com>');
    expect(slackMrkdwnOf('[ops](mailto:ops@example.com)')).toBe('<mailto:ops@example.com|ops>');
    expect(slackMrkdwnOf('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
      '<https://en.wikipedia.org/wiki/Foo_(bar)|wiki>',
    );
  });

  it('keeps a relative link in sight, because Slack cannot open it', () => {
    expect(slackMrkdwnOf('read [the help](/help/slack-channel)')).toBe(
      'read the help (/help/slack-channel)',
    );
  });

  it('turns -, * and + bullets into Slack bullets, nested ones included', () => {
    expect(slackMrkdwnOf('- one\n* two\n+ three\n  - nested **b**\n\t- tabbed')).toBe(
      '• one\n• two\n• three\n  • nested *b*\n    • tabbed',
    );
    expect(slackMrkdwnOf('1. first\n2. second')).toBe('1. first\n2. second');
  });

  it('turns a horizontal rule into a line, and keeps a quote a quote', () => {
    expect(slackMrkdwnOf('above\n---\nbelow')).toBe('above\n──────────\nbelow');
    expect(slackMrkdwnOf('> a **quoted** line')).toBe('> a *quoted* line');
  });

  it('escapes &, < and > that open nothing in Slack', () => {
    expect(slackMrkdwnOf('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('leaves text that is already Slack mrkdwn as it is', () => {
    const slack = [
      '_italic_ and ~struck~ and `code`',
      '• a bullet',
      'see <https://example.com/a?b=1&amp;c=2|the page> or <https://example.com>',
      'ask <@U024BE7LH> in <#C024BE7LR|general>, <!here> <!subteam^S012|@ops>',
      'R&amp;D &lt;final&gt;',
      '> a quote',
      '```\ncode\n```',
    ].join('\n');
    expect(slackMrkdwnOf(slack)).toBe(slack);
  });

  it('turns a message that mixes all of them into mrkdwn with no markdown left', () => {
    const markdown = [
      '# Deploy report',
      '',
      'The **staging** deploy *finished*. Run `yarn verify` before you merge.',
      '',
      '## Changes',
      '- Fixed the [login page](https://example.com/login)',
      '- Raised the **timeout** to `30s`',
      '',
      '```bash',
      'yarn deploy --env=prod && echo "<done>"',
      '```',
      '',
      'Ask <@U024BE7LH> if anything looks wrong.',
    ].join('\n');

    expect(slackMrkdwnOf(markdown)).toBe(
      [
        '*Deploy report*',
        '',
        'The *staging* deploy _finished_. Run `yarn verify` before you merge.',
        '',
        '*Changes*',
        '• Fixed the <https://example.com/login|login page>',
        '• Raised the *timeout* to `30s`',
        '',
        '```',
        'yarn deploy --env=prod &amp;&amp; echo "&lt;done&gt;"',
        '```',
        '',
        'Ask <@U024BE7LH> if anything looks wrong.',
      ].join('\n'),
    );
  });
});

describe('mrkdwnUnits', () => {
  it('keeps entities and Slack references whole, and splits the rest by character', () => {
    expect(mrkdwnUnits('a&amp;<https://x.io|x>é')).toEqual(['a', '&amp;', '<https://x.io|x>', 'é']);
  });
});
