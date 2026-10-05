/**
 * The ports this stack serves on, on this machine, as far as one process can tell.
 *
 * A browser profile may be opened to loopback ports the operator names, and
 * never to one of these: the local web application has no login, so a page
 * loaded from it — or from the API or the MCP server behind it — could approve
 * the agent's own requests (Plan 320 D12). Each service's port is configured
 * by an environment variable the service or its Compose file reads, with a
 * default where none is set; this reads the same variables from the caller's
 * environment and always adds the defaults. A port another process was moved
 * to in an environment this one does not share cannot be seen from here.
 */
import { BAKED_API_PORT } from './applianceBundle.js';
import { WEB_BASE_URL_ENV_KEYS } from './webBaseUrl.js';

export const STACK_SERVICES = [
  'api',
  'web',
  'mcp',
  'redis',
  'postgres',
  'pgadmin',
  'redis-commander',
] as const;
export type StackService = (typeof STACK_SERVICES)[number];

export const STACK_SERVICE_NAMES: Readonly<Record<StackService, string>> = {
  api: 'the API',
  web: 'the web application',
  mcp: 'the MCP server',
  redis: 'Redis',
  postgres: 'Postgres',
  pgadmin: 'pgAdmin',
  'redis-commander': 'Redis Commander',
};

/** `PORT` for the server, `AFLOW_API_PORT` where the appliance publishes it. */
export const DEFAULT_API_PORT = Number(BAKED_API_PORT);
/** The dev runner's `WEB_DEV_PORT` and the appliance's `AFLOW_WEB_PORT`. */
export const DEFAULT_WEB_PORT = 3001;
/** The local web application's own dev script, run without the dev runner. */
export const WEB_LOCAL_STANDALONE_PORT = 3002;
export const DEFAULT_MCP_PORT = 3100;
/** Where `docker-compose.yml` publishes Redis for the dev stack. */
export const DEFAULT_REDIS_PORT = 6379;
/** Where the appliance publishes its Redis for a paired machine (`AFLOW_REDIS_PORT`). */
export const APPLIANCE_REDIS_PORT = 6380;
/** Where `docker-compose.yml` publishes Postgres (`POSTGRES_PORT`). */
export const DEFAULT_POSTGRES_PORT = 5433;
/** `yarn infra:tools`, fixed in `docker-compose.yml`. */
export const PGADMIN_PORT = 8080;
export const REDIS_COMMANDER_PORT = 8081;

interface PortSource {
  readonly service: StackService;
  /** A variable holding a port, or one holding a URL whose port is the service's. */
  readonly holds: 'port' | 'url';
  readonly key: string;
}

const ENV_SOURCES: readonly PortSource[] = [
  { service: 'api', holds: 'port', key: 'PORT' },
  { service: 'api', holds: 'port', key: 'AFLOW_API_PORT' },
  { service: 'api', holds: 'url', key: 'API_BASE_URL' },
  { service: 'api', holds: 'url', key: 'AFLOW_API_URL' },
  { service: 'web', holds: 'port', key: 'WEB_DEV_PORT' },
  { service: 'web', holds: 'port', key: 'AFLOW_WEB_PORT' },
  ...WEB_BASE_URL_ENV_KEYS.map((key): PortSource => ({ service: 'web', holds: 'url', key })),
  { service: 'mcp', holds: 'port', key: 'MCP_PORT' },
  { service: 'mcp', holds: 'port', key: 'AFLOW_MCP_PORT' },
  { service: 'redis', holds: 'url', key: 'REDIS_URL' },
  { service: 'redis', holds: 'port', key: 'REDIS_PORT' },
  { service: 'redis', holds: 'port', key: 'AFLOW_REDIS_PORT' },
  { service: 'redis', holds: 'url', key: 'PHOENIX_HOST_REDIS_URL' },
  { service: 'postgres', holds: 'url', key: 'DATABASE_URL' },
  { service: 'postgres', holds: 'port', key: 'POSTGRES_PORT' },
];

const DEFAULTS: ReadonlyArray<readonly [StackService, number]> = [
  ['api', DEFAULT_API_PORT],
  ['web', DEFAULT_WEB_PORT],
  ['web', WEB_LOCAL_STANDALONE_PORT],
  ['mcp', DEFAULT_MCP_PORT],
  ['redis', DEFAULT_REDIS_PORT],
  ['redis', APPLIANCE_REDIS_PORT],
  ['postgres', DEFAULT_POSTGRES_PORT],
  ['pgadmin', PGADMIN_PORT],
  ['redis-commander', REDIS_COMMANDER_PORT],
];

/** The port a URL connects to when it names none. */
const SCHEME_PORTS: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
  'redis:': 6379,
  'rediss:': 6379,
  'postgres:': 5432,
  'postgresql:': 5432,
};

function portOf(value: string, holds: PortSource['holds']): number | undefined {
  const text = value.trim();
  if (text === '') return undefined;
  if (holds === 'port') {
    const port = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  return url.port !== '' ? Number(url.port) : SCHEME_PORTS[url.protocol];
}

export interface StackPortOwner {
  readonly service: StackService;
  /** The variable that names the port, or `default`. */
  readonly from: string;
}

/**
 * Every port this stack may be serving on here, with the service it belongs
 * to: the ports the caller's environment names for each service, and every
 * default whether or not one was moved.
 */
export function stackOwnPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<number, StackPortOwner> {
  const ports = new Map<number, StackPortOwner>();
  for (const { service, holds, key } of ENV_SOURCES) {
    const value = env[key];
    const port = value === undefined ? undefined : portOf(value, holds);
    if (port !== undefined && !ports.has(port)) ports.set(port, { service, from: key });
  }
  for (const [service, port] of DEFAULTS) {
    if (!ports.has(port)) ports.set(port, { service, from: 'default' });
  }
  return ports;
}

/** "the web application, by default", "the API, as PORT sets it". */
export function describeStackPortOwner(owner: StackPortOwner): string {
  const name = STACK_SERVICE_NAMES[owner.service];
  return owner.from === 'default' ? `${name}, by default` : `${name}, as ${owner.from} sets it`;
}
