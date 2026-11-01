/**
 * Slack's wire encoding of a message's text, read back to the text the
 * operator typed.
 *
 * Slack escapes `&`, `<` and `>` as entities, and wraps every link, mention and
 * channel reference in angle brackets: `<https://example.com>`,
 * `<http://example.com|example.com>`, `<@U123>`, `<#C123|general>`,
 * `<!here>`. A raw `<` in the wire text therefore always opens one of these,
 * and an escaped one is a character the operator typed.
 *
 * Slack sends a member mention as the member ID alone, and a channel link may
 * carry no name. Those read back as `@U123` and `#C123`, the reference the
 * operator chose, because the app holds no scope to look the name up.
 */

const ENTITY = /&(amp|lt|gt);/g;

const WIRE_TOKEN = /<([^<>]*)>|&(amp|lt|gt);/g;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>' };

function entity(name: string): string {
  return ENTITIES[name] ?? `&${name};`;
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (_match, name: string) => entity(name));
}

function withoutScheme(url: string): string {
  return url.replace(/^(?:https?:\/\/|mailto:)/, '');
}

function decodeReference(inner: string): string {
  const bar = inner.indexOf('|');
  const target = decodeEntities(bar === -1 ? inner : inner.slice(0, bar));
  const label = bar === -1 ? undefined : decodeEntities(inner.slice(bar + 1));

  if (target.startsWith('@')) return label === undefined ? target : `@${label.replace(/^@/, '')}`;
  if (target.startsWith('#')) return label === undefined ? target : `#${label.replace(/^#/, '')}`;
  if (target.startsWith('!')) {
    if (label !== undefined) return label;
    const special = target.slice(1);
    return `@${/^subteam\^(.+)$/.exec(special)?.[1] ?? special}`;
  }
  // Slack labels a link it found in typed text with the text as typed.
  if (label === undefined) return target;
  if (label === target || label === withoutScheme(target)) return label;
  return `${label} (${target})`;
}

/** The text of a Slack message event, as the operator typed it. */
export function typedTextOf(wireText: string): string {
  return wireText.replace(
    WIRE_TOKEN,
    (_match, inner: string | undefined, name: string | undefined) =>
      inner === undefined ? entity(name ?? '') : decodeReference(inner),
  );
}
