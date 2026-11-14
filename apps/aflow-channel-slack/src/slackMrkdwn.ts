/**
 * An agent's markdown as Slack mrkdwn, for every message the agent sends.
 *
 * Models write CommonMark: `# headings`, `**bold**`, `*italic*`, `[text](url)`
 * and `-` bullets. Slack reads none of those, so they would show as typed.
 * Each maps to the nearest mrkdwn: a heading to a bold line, `**bold**` and
 * `__bold__` to `*bold*`, `*italic*` to `_italic_`, `~~struck~~` to
 * `~struck~`, a link to `<url|text>` and a bullet to `•`. Code spans and fenced
 * blocks keep their backticks, and nothing inside them is read as markup.
 *
 * Mrkdwn already in the text stays as it is: `<url|text>` links, mentions,
 * `_italic_`, `~struck~`, `•` bullets, `>` quotes and the entities `&amp;`,
 * `&lt;` and `&gt;`. A single-asterisk span is the one overlap, and it reads
 * as markdown italic, because the text is a model's markdown.
 *
 * Every other `&`, `<` and `>` is escaped, so a `<` in the result always opens
 * a Slack reference and an `&` always opens an entity. `mrkdwnUnits` relies on
 * that to cut the result without breaking either.
 */

const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^([ \t]*>[ \t]?)(.*)$/;

const ENTITY = /&(?:amp|lt|gt);/y;
/** A link, mention, channel or broadcast reference in Slack's own syntax. */
const SLACK_REFERENCE =
  /<(?:(?:https?:\/\/|mailto:)[^\s<>|]+|[@#][A-Z0-9]+|![\w^-]+)(?:\|[^<>\n]*)?>/y;
const CODE_SPAN = /(`+)([^\n]*?[^`\n])\1(?!`)/y;
const LINK =
  /!?\[([^\]\n]*)\]\(\s*<?([^\s<>()]+(?:\([^\s<>()]*\)[^\s<>()]*)*)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/y;

const SLACK_LINKABLE = /^(?:https?:\/\/|mailto:)/;

/** Marks a bold span until italics are read, so its asterisks are not taken for them. */
const BOLD_MARK = '\uE000';
const HELD = '\uE001';
const HELD_REF = /\uE001(\d+)\uE001/g;

const UNIT = /&(?:amp|lt|gt);|<[^<>]*>|[\s\S]/gu;

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `[text](url)` as Slack links it. A relative url opens nothing in Slack, so it stays in sight. */
function link(label: string, url: string): string {
  const shown = escapeText(label.replace(/\*\*|__|`/g, ''));
  if (!SLACK_LINKABLE.test(url)) {
    return shown === '' ? escapeText(url) : `${shown} (${escapeText(url)})`;
  }
  return shown === '' ? `<${escapeText(url)}>` : `<${escapeText(url)}|${shown}>`;
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, `${BOLD_MARK}$1${BOLD_MARK}`)
    .replace(/(^|\W)__(?=\S)([^\n]*?\S)__(?!\w)/g, `$1${BOLD_MARK}$2${BOLD_MARK}`)
    .replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g, '$1_$2_')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '~$1~')
    .replaceAll(BOLD_MARK, '*');
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text) ?? undefined;
}

/** One line of prose, with code spans, links and Slack references held out of the markup. */
function inline(line: string): string {
  const held: string[] = [];
  const hold = (piece: string): string => {
    held.push(piece);
    return `${HELD}${String(held.length - 1)}${HELD}`;
  };

  let prose = '';
  let at = 0;
  while (at < line.length) {
    const kept = matchAt(ENTITY, line, at) ?? matchAt(SLACK_REFERENCE, line, at);
    if (kept !== undefined) {
      prose += hold(kept[0]);
      at += kept[0].length;
      continue;
    }
    const code = matchAt(CODE_SPAN, line, at);
    if (code !== undefined) {
      const body = code[2] ?? '';
      prose += hold(`\`${escapeText(body.trim() === '' ? body : body.trim())}\``);
      at += code[0].length;
      continue;
    }
    const linked = matchAt(LINK, line, at);
    if (linked !== undefined) {
      prose += hold(link(linked[1] ?? '', linked[2] ?? ''));
      at += linked[0].length;
      continue;
    }
    const char = line[at] ?? '';
    prose += char === HELD || char === BOLD_MARK ? '' : escapeText(char);
    at += 1;
  }

  return emphasis(prose).replace(HELD_REF, (_match, index: string) => held[Number(index)] ?? '');
}

function proseLine(line: string): string {
  const heading = HEADING.exec(line);
  if (heading !== null) {
    const text = inline((heading[1] ?? '').replace(/\*\*|__/g, ''));
    return text === '' ? '' : `*${text}*`;
  }
  if (RULE.test(line)) return '──────────';
  const bullet = BULLET.exec(line);
  if (bullet !== null) {
    const indent = (bullet[1] ?? '').replace(/\t/g, '    ');
    return `${indent}• ${inline(bullet[2] ?? '')}`;
  }
  const quote = QUOTE.exec(line);
  if (quote !== null) return `${quote[1] ?? ''}${proseLine(quote[2] ?? '')}`;
  return inline(line);
}

function codeBlock(lines: readonly string[]): string {
  // Slack ends a block at the first ``` inside it.
  const body = escapeText(lines.join('\n')).replace(/```/g, '`\u200b``');
  return `\`\`\`\n${body}\n\`\`\``;
}

/** Whether `line` closes a block that `fence` opened: the same character, at least as many. */
function closes(fence: string, line: string): boolean {
  const run = FENCE.exec(line)?.[1];
  return (
    run !== undefined &&
    fence.startsWith(run.charAt(0)) &&
    run.length >= fence.length &&
    line.trim() === run
  );
}

/** `markdown` as Slack mrkdwn. */
export function slackMrkdwnOf(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let code: string[] = [];

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== undefined) {
      if (closes(fence, line)) {
        out.push(codeBlock(code));
        fence = undefined;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    const opening = FENCE.exec(line);
    const run = opening?.[1];
    // A backtick fence whose info string holds a backtick is a code span instead.
    if (
      opening !== null &&
      run !== undefined &&
      !(run.startsWith('`') && line.slice(opening[0].length).includes('`'))
    ) {
      fence = run;
      continue;
    }
    out.push(proseLine(line));
  }
  if (fence !== undefined) out.push(codeBlock(code));
  return out.join('\n');
}

/**
 * Mrkdwn in the pieces a cut must not split: an entity, a Slack reference, or
 * one character.
 */
export function mrkdwnUnits(mrkdwn: string): string[] {
  return mrkdwn.match(UNIT) ?? [];
}
