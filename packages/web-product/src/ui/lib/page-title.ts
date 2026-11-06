/**
 * The browser title of a space page: `<page> · <space> · Aflow`. A page this
 * table does not name keeps the root layout's static `Aflow`.
 */
export const APP_TITLE = 'Aflow';

/** The page name for each first segment under `/s/<space>/`, as the rail labels it. */
const SPACE_PAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['chat', 'Chat'],
  ['plan', 'Plan'],
  ['skills', 'Skills'],
  ['integrations', 'Integrations'],
  ['store', 'Store'],
  ['memory', 'Memory'],
  ['triggers', 'Triggers'],
  ['computer', 'This Computer'],
  ['settings', 'Settings'],
  ['agents', 'Agents'],
  ['applets', 'Applets'],
  ['catalog', 'Catalog'],
  ['sessions', 'Sessions'],
]);

const SPACE_PAGE_PATH = /^\/s\/[^/]+\/([^/?#]+)/;

export function spacePageTitle(pathname: string, spaceName: string | undefined): string {
  const segment = SPACE_PAGE_PATH.exec(pathname)?.[1];
  const page = segment !== undefined ? SPACE_PAGE_NAMES.get(segment) : undefined;
  if (page === undefined) return APP_TITLE;
  const space = spaceName?.trim();
  return space ? `${page} · ${space} · ${APP_TITLE}` : `${page} · ${APP_TITLE}`;
}
