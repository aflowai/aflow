/**
 * An agent writes markdown, and Slack shows mrkdwn. Every message the agent
 * sends must read in Slack with no markdown left in sight.
 */
import { describe, expect, it } from 'vitest';

import { mrkdwnUnits, slackMrkdwnOf, slackMrkdwnWithin } from '../slackMrkdwn.js';

describe('slackMrkdwnOf', () => {
  it('turns every heading level into a bold line', () => {
    expect(slackMrkdwnOf('# Release')).toBe('*Release*');
    expect(slackMrkdwnOf('### Next steps ###')).toBe('*Next steps*');
    expect(slackMrkdwnOf('## The **final** plan')).toBe('*The final plan*');
    expect(slackMrkdwnOf('#hashtag stays')).toBe('#hashtag stays');
  });

  it('turns **bold** and __bold words__ into *bold*', () => {
    expect(slackMrkdwnOf('a **strong** word')).toBe('a *strong* word');
    expect(slackMrkdwnOf('a __strong words__ here')).toBe('a *strong words* here');
    expect(slackMrkdwnOf('**one** and **two**')).toBe('*one* and *two*');
  });

  it('leaves a Python dunder name outside backticks as it is', () => {
    expect(slackMrkdwnOf('define __init__ and check __name__ == "__main__"')).toBe(
      'define __init__ and check __name__ == "__main__"',
    );
    expect(slackMrkdwnOf('read obj.__dict__ in __init__.py')).toBe(
      'read obj.__dict__ in __init__.py',
    );
    expect(slackMrkdwnOf('# The __init__ method')).toBe('*The __init__ method*');
    expect(slackMrkdwnOf('[__init__](https://docs.python.org)')).toBe(
      '<https://docs.python.org|__init__>',
    );
    expect(slackMrkdwnOf('__init__ runs __before anything__')).toBe(
      '__init__ runs *before anything*',
    );
  });

  it('turns ***bold italic*** into bold around italic, and never misnests the two', () => {
    expect(slackMrkdwnOf('a ***loud*** word')).toBe('a *_loud_* word');
    expect(slackMrkdwnOf('***all of it*** and **more**')).toBe('*_all of it_* and *more*');
    expect(slackMrkdwnOf('# ***Loud*** heading')).toBe('*_Loud_ heading*');
    expect(slackMrkdwnOf('**a *b***')).toBe('**a *b***');
    expect(slackMrkdwnOf('***a** b*')).toBe('***a** b*');
    expect(slackMrkdwnOf('__a **b__ c**')).toBe('__a *b__ c*');
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

describe('slackMrkdwnWithin', () => {
  it('is the whole conversion when it fits', () => {
    const markdown = '# Done\n**All** checks passed.\n```\ncode\n```';
    expect(slackMrkdwnWithin(markdown, 1_000)).toBe(slackMrkdwnOf(markdown));
  });

  it('cuts between whole spans, so no bold, italic, struck or code span stays open', () => {
    expect(slackMrkdwnWithin('one **two three** four', 12)).toBe('one ');
    expect(slackMrkdwnWithin('one *two three* four', 12)).toBe('one ');
    expect(slackMrkdwnWithin('one ~~two three~~ four', 12)).toBe('one ');
    expect(slackMrkdwnWithin('one `two three` four', 12)).toBe('one ');
    expect(slackMrkdwnWithin('one ***two three*** four', 14)).toBe('one ');
    expect(slackMrkdwnWithin('# A heading\nmore', 8)).toBe('');
    expect(slackMrkdwnWithin('one **two** three', 12)).toBe('one *two* th');
  });

  it('closes a code block the cut ends inside', () => {
    const markdown = 'Before\n```\nline one\nline two\n```\nAfter';
    expect(slackMrkdwnWithin(markdown, 23)).toBe('Before\n```\nline one\n```');
    expect(slackMrkdwnWithin(markdown, 11)).toBe('Before\n');
  });

  it('keeps entities and Slack references whole', () => {
    expect(slackMrkdwnWithin('a & <https://x.io|x> b', 8)).toBe('a &amp; ');
  });

  it('reads the private-use characters it marks with as nothing in the input', () => {
    expect(slackMrkdwnOf('abc')).toBe('abc');
  });
});

describe('mrkdwnUnits', () => {
  it('keeps entities and Slack references whole, and splits the rest by character', () => {
    expect(mrkdwnUnits('a&amp;<https://x.io|x>é')).toEqual(['a', '&amp;', '<https://x.io|x>', 'é']);
  });
});
