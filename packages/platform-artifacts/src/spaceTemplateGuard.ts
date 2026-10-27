/**
 * What a space template may not carry (Plan 330 D6), and what it must resolve
 * (D5), read statically from its content.
 *
 * A template is installed on machines and against repositories its author has
 * never seen, so anything it names of the author's own — a folder, a port, a
 * repository, a binding, a credential, a schedule, a host — is wrong for every
 * other operator. Its directives refer to "the space's connected folder" and
 * "the space's github binding", which a run resolves when it starts.
 *
 * Pages are read by the web product's route guard and commands by the host
 * CLI's; both need sources this package does not depend on.
 */
import type { SpaceTemplate } from '@aflow/schemas';

import { allHelpArticles } from './helpCenter/index.js';
import { getSkillBundleEntry } from './skillBundleCatalog.js';

interface TemplateString {
  path: string;
  value: string;
  key: string;
}

function collectStrings(value: unknown, path: string, key: string, out: TemplateString[]): void {
  if (typeof value === 'string') {
    out.push({ path, value, key });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStrings(item, `${path}[${String(index)}]`, key, out);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, path === '' ? childKey : `${path}.${childKey}`, childKey, out);
    }
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`)<>]+/gi;
const ABSOLUTE_PATH = /(?:^|[\s"'`(=[])(~?\/[\w.-]+(?:\/[\w.-]+)+\/?|[A-Za-z]:\\[\w\\. -]+)/;
const HOST_PORT = /\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\b/i;
const PORT_WORD = /\bports?\s+\d{2,5}\b|(?:^|\s):\d{2,5}\b/i;
const OWNER_REPO =
  /(?<![\w/.:@{-])([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9](?:[\w-]|\.(?=[\w-])){0,99})(?![\w/{])/g;
const NOT_A_REPOSITORY = new Set(['and/or']);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const HOST_BINDING_ID = /\bhb_[a-z0-9]+\b/i;
const ID_KEYS = /^(?:\w*[bB]indingId|credentialKey|\w*CredentialKey|scheduleId)$/;
const HOST_NAME =
  /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|app|co|cloud|sh|me|local|internal|lan|xyz|us|uk|de|eu))\b/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url.replace(/\{[^}]*\}/g, 'x')).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The hosts the template's own api_definitions call — the only ones it may name. */
function ownApiHosts(template: SpaceTemplate): Set<string> {
  const hosts = new Set<string>();
  for (const { definition } of template.apiDefinitions) {
    for (const url of [definition.baseUrl, definition.baseUrlTemplate]) {
      if (url === undefined) continue;
      const host = hostOf(url);
      if (host) hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Everything in the template that names this machine, this repository or this
 * operator. Readiness pages are space-relative routes, not paths, and an
 * api_definition's endpoint paths are HTTP paths; both are left to the route
 * and definition checks.
 */
export function findSpaceTemplateLocalReferences(
  template: SpaceTemplate,
  /** The listing's own words around the template — its name, tagline and description. */
  listing: Readonly<Record<string, unknown>> = {},
): string[] {
  const strings: TemplateString[] = [];
  collectStrings(template, '', '', strings);
  collectStrings(listing, 'listing', 'listing', strings);
  const allowedHosts = ownApiHosts(template);
  const problems: string[] = [];
  const report = (at: TemplateString, what: string, found: string): void => {
    problems.push(`${template.templateId} ${at.path}: ${what} '${found}'`);
  };

  for (const at of strings) {
    const isRoute = /^readiness\[\d+\]\.page$/.test(at.path);
    const isHttpPath = at.path.startsWith('apiDefinitions[') && at.key === 'path';
    for (const url of at.value.match(URL_PATTERN) ?? []) {
      const host = hostOf(url);
      if (host && !allowedHosts.has(host)) report(at, 'a host name', host);
    }
    const prose = at.value.replace(URL_PATTERN, ' ');

    if (!isRoute && !isHttpPath) {
      const path = ABSOLUTE_PATH.exec(prose);
      if (path?.[1]) report(at, 'an absolute path', path[1]);
    }
    const hostPort = HOST_PORT.exec(prose) ?? PORT_WORD.exec(prose);
    if (hostPort) report(at, 'a port number', hostPort[0].trim());
    if (!isRoute && !isHttpPath) {
      for (const match of prose.matchAll(OWNER_REPO)) {
        if (!NOT_A_REPOSITORY.has(match[0].toLowerCase()))
          report(at, 'an owner/repo pair', match[0]);
      }
    }
    const uuid = UUID.exec(prose);
    if (uuid) report(at, 'an id', uuid[0]);
    const hostBinding = HOST_BINDING_ID.exec(prose);
    if (hostBinding) report(at, 'a binding id', hostBinding[0]);
    if (ID_KEYS.test(at.key)) report(at, `a ${at.key}`, at.value);
    for (const match of prose.matchAll(HOST_NAME)) {
      const host = match[0].toLowerCase();
      if (!allowedHosts.has(host)) report(at, 'a host name', host);
    }
  }
  return problems;
}

/** Bundle ids and help article ids the template names that resolve to nothing. */
export function findSpaceTemplateUnresolvedReferences(template: SpaceTemplate): string[] {
  const problems: string[] = [];
  for (const [index, bundleId] of template.bundleIds.entries()) {
    const bundle = getSkillBundleEntry(bundleId);
    if (bundle === null) {
      problems.push(`${template.templateId}: bundle '${bundleId}' is not in the bundle catalog`);
      continue;
    }
    // The bundle install refuses a bundle whose prerequisites are not in the
    // space yet, and the template's space starts empty.
    for (const prerequisite of bundle.prerequisiteBundleIds) {
      if (!template.bundleIds.slice(0, index).includes(prerequisite)) {
        problems.push(
          `${template.templateId}: bundle '${bundleId}' needs '${prerequisite}' installed before it`,
        );
      }
    }
  }
  const articleIds = new Set(allHelpArticles().map((article) => article.id));
  for (const articleId of template.help) {
    if (!articleIds.has(articleId)) {
      problems.push(`${template.templateId}: help article '${articleId}' does not exist`);
    }
  }
  const bundleSkills = new Set(
    template.bundleIds.flatMap((bundleId) => getSkillBundleEntry(bundleId)?.skillCatalogIds ?? []),
  );
  for (const agent of template.agents) {
    if (!bundleSkills.has(agent.skillCatalogId)) {
      problems.push(
        `${template.templateId}: agent '${agent.name}' starts '${agent.skillCatalogId}', which none of its bundles carries`,
      );
    }
  }
  return problems;
}
