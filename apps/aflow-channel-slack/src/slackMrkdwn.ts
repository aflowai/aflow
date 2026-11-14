/**
 * An agent's markdown as Slack mrkdwn, for every message the agent sends.
 *
 * Models write CommonMark: `# headings`, `**bold**`, `*italic*`, `[text](url)`
 * and `-` bullets. Slack reads none of those, so they would show as typed.
 * Each maps to the nearest mrkdwn: a heading to a bold line, `**bold**` and
 * `__bold words__` to `*bold*`, `*italic*` to `_italic_`, `***both***` to
 * `*_both_*`, `~~struck~~` to `~struck~`, a link to `<url|text>` and a bullet
 * to `•`. Code spans and fenced blocks keep their backticks, and nothing inside
 * them is read as markup. A `__name__` of one word stays as it is, because it
 * is far more often a Python dunder name than a bold word.
 *
 * Mrkdwn already in the text stays as it is: `<url|text>` links, mentions,
 * `_italic_`, `~struck~`, `•` bullets, `>` quotes and the entities `&amp;`,
 * `&lt;` and `&gt;`. A single-asterisk span is the one overlap, and it reads
 * as markdown italic, because the text is a model's markdown.
 *
 * Every other `&`, `<` and `>` is escaped, so a `<` in the result always opens
 * a Slack reference and an `&` always opens an entity. `mrkdwnUnits` relies on
 * that to cut the result without breaking either.
 *
 * The conversion first writes a marked form. A private-use character brackets
 * every span it emits and every code block it opens. `slackMrkdwnWithin` cuts
 * that form, so a cut never leaves a span open.
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
const SPAN_OPEN = '\uE002';
const SPAN_CLOSE = '\uE003';
const BLOCK_OPEN = '\uE004';
const BLOCK_CLOSE = '\uE005';
const PRIVATE_MARKS = /[\uE000-\uE005]/g;
const SPAN_MARKS = /[\uE002\uE003]/g;

const BLOCK_START = '```\n';
const BLOCK_END = '\n```';

/** The body of a `__name__` of one word, which reads as a Python dunder name rather than bold. */
const DUNDER_BODY = /^\w+$/;
const UNDERSCORE_BOLD = /(^|\W)__(?=\S)([^\n]*?\S)__(?!\w)/g;

const UNIT = /&(?:amp|lt|gt);|<[^<>]*>|[\s\S]/gu;
const MARKED_UNIT = /&(?:amp|lt|gt);|<[^<>]*>|[\s\S]/uy;

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `[text](url)` as Slack links it. A relative url opens nothing in Slack, so it stays in sight. */
function link(label: string, url: string): string {
  const shown = escapeText(
    label
      .replace(/\*\*|`/g, '')
      .replace(UNDERSCORE_BOLD, (match: string, before: string, body: string) =>
        DUNDER_BODY.test(body) ? match : `${before}${body}`,
      ),
  );
  if (!SLACK_LINKABLE.test(url)) {
    return shown === '' ? escapeText(url) : `${shown} (${escapeText(url)})`;
  }
  return shown === '' ? `<${escapeText(url)}>` : `<${escapeText(url)}|${shown}>`;
}

function span(text: string): string {
  return `${SPAN_OPEN}${text}${SPAN_CLOSE}`;
}

/** Whether every span that opens in `body` also closes in it. */
function balanced(body: string): boolean {
  let depth = 0;
  for (const char of body) {
    if (char === SPAN_OPEN) depth += 1;
    if (char === SPAN_CLOSE) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The emphasis in `text` as mrkdwn, with `bold` written for each bold marker.
 * A span that would cross one already written stays as typed, so no markup
 * this writes is misnested.
 */
function emphasis(text: string, bold: string): string {
  const strong = (body: string): string => span(`${BOLD_MARK}${body}${BOLD_MARK}`);
  const wrapped =
    (write: (body: string) => string) =>
    (match: string, before: string, body: string): string =>
      balanced(body) ? `${before}${write(body)}` : match;
  return (
    text
      // Bold outside italic, so the two close in the order they opened.
      .replace(
        /()(?<!\*)\*\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*\*(?!\*)/g,
        wrapped((body) => strong(span(`_${body}_`))),
      )
      .replace(/()(?<!\*)\*\*([^\s*](?:[^\n]*?[^\s*])?)\*\*(?!\*)/g, wrapped(strong))
      .replace(UNDERSCORE_BOLD, (match: string, before: string, body: string) =>
        DUNDER_BODY.test(body) ? match : wrapped(strong)(match, before, body),
      )
      .replace(
        /(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![*\w])/g,
        wrapped((body) => span(`_${body}_`)),
      )
      .replace(
        /()~~(?=\S)([^\n]*?\S)~~/g,
        wrapped((body) => span(`~${body}~`)),
      )
      .replaceAll(BOLD_MARK, bold)
  );
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text) ?? undefined;
}

/** One line of prose, with code spans, links and Slack references held out of the markup. */
function inline(line: string, bold = '*'): string {
  const held: string[] = [];
  const hold = (piece: string): string => {
    held.push(span(piece));
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
    prose += escapeText(line[at] ?? '');
    at += 1;
  }

  return emphasis(prose, bold).replace(
    HELD_REF,
    (_match, index: string) => held[Number(index)] ?? '',
  );
}

function proseLine(line: string): string {
  const heading = HEADING.exec(line);
  if (heading !== null) {
    const text = inline(heading[1] ?? '', '');
    return text.replace(SPAN_MARKS, '') === '' ? '' : span(`*${text}*`);
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
  return `${BLOCK_OPEN}${body}${BLOCK_CLOSE}`;
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

/** `markdown` as mrkdwn in its marked form. */
function markedMrkdwnOf(markdown: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  let code: string[] = [];

  const text = markdown.replace(PRIVATE_MARKS, '').replace(/\r\n?/g, '\n');
  for (const line of text.split('\n')) {
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

/** A piece of the marked form as Slack shows it. */
function rendered(marked: string): string {
  return marked
    .replace(SPAN_MARKS, '')
    .replaceAll(BLOCK_OPEN, BLOCK_START)
    .replaceAll(BLOCK_CLOSE, BLOCK_END);
}

/** `markdown` as Slack mrkdwn. */
export function slackMrkdwnOf(markdown: string): string {
  return rendered(markedMrkdwnOf(markdown));
}

/**
 * Mrkdwn in the pieces a cut must not split: an entity, a Slack reference, or
 * one character.
 */
export function mrkdwnUnits(mrkdwn: string): string[] {
  return mrkdwn.match(UNIT) ?? [];
}

/** The marked form in pieces: a whole span, an entity, a Slack reference, or one character. */
function markedUnits(marked: string): string[] {
  const units: string[] = [];
  let at = 0;
  while (at < marked.length) {
    if (marked[at] === SPAN_OPEN) {
      let depth = 0;
      let end = at;
      for (; end < marked.length; end += 1) {
        if (marked[end] === SPAN_OPEN) depth += 1;
        if (marked[end] === SPAN_CLOSE) depth -= 1;
        if (depth === 0) break;
      }
      units.push(marked.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    const unit = matchAt(MARKED_UNIT, marked, at)?.[0] ?? marked.charAt(at);
    units.push(unit);
    at += unit.length;
  }
  return units;
}

/**
 * `markdown` as Slack mrkdwn of at most `room` characters. A cut falls between
 * whole spans, entities and references, so it leaves no bold, italic, struck
 * or code span open. A code block the cut ends inside is closed.
 */
export function slackMrkdwnWithin(markdown: string, room: number): string {
  let out = '';
  let inBlock = false;
  for (const unit of markedUnits(markedMrkdwnOf(markdown))) {
    const open: boolean = unit === BLOCK_OPEN || (inBlock && unit !== BLOCK_CLOSE);
    const text = rendered(unit);
    if (out.length + text.length + (open ? BLOCK_END.length : 0) > room) break;
    out += text;
    inBlock = open;
  }
  if (!inBlock) return out;
  return out.endsWith(BLOCK_START) ? out.slice(0, -BLOCK_START.length) : `${out}${BLOCK_END}`;
}
