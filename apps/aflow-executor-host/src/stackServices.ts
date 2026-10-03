/**
 * The stack's own services, as this lane knows them, and the network entries
 * that keep a job from reaching them (Plan 315 D19, F98).
 *
 * The stack's Redis takes no password in development and holds run state and
 * the write-approval grants the push gate reads, so a command that reaches it
 * can mint the grant that clears its own push. Its database, its API and its
 * web application, which presents the instance secret to whoever loads it,
 * are the same kind of door. The lane keeps no record of the stack: it holds
 * the Redis it was paired with, and for the rest the address the environment
 * names, else the port the stack publishes by default.
 */
import { isIP } from 'node:net';

import { BAKED_API_PORT } from '@aflow/lib/appliance-bundle';
import { getRedisConfig } from '@aflow/redis';

export interface StackService {
  readonly host: string;
  readonly port: number;
}

export const STACK_API_PORT_DEFAULT = Number(BAKED_API_PORT);
export const STACK_WEB_PORT_DEFAULT = 3001;
/** Where the development Compose file publishes Postgres by default. */
export const STACK_DATABASE_PORT_DEFAULT = 5433;
const REDIS_DEFAULT_PORT = 6379;
/** What a URL means when it names no port. */
const SCHEME_DEFAULT_PORTS: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
  'redis:': REDIS_DEFAULT_PORT,
  'rediss:': REDIS_DEFAULT_PORT,
  'postgres:': 5432,
  'postgresql:': 5432,
};

const LOOPBACK_NAME = 'localhost';
const LOOPBACK_SPELLINGS = [LOOPBACK_NAME, '127.0.0.1', '[::1]'] as const;
const LOOPBACK_ADDRESS = '127.0.0.1';

function unbracketed(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** A host naming this machine's loopback, or every address it answers on. */
function isLoopbackHost(host: string): boolean {
  const bare = unbracketed(host).toLowerCase();
  if (bare === LOOPBACK_NAME || bare.endsWith(`.${LOOPBACK_NAME}`)) return true;
  if (isIP(bare) === 4) return bare.startsWith('127.') || bare === '0.0.0.0';
  return bare === '::1' || bare === '::';
}

function serviceAt(url: string | undefined): StackService | undefined {
  const text = url?.trim();
  if (text === undefined || text === '' || !URL.canParse(text)) return undefined;
  const parsed = new URL(text);
  const port = parsed.port === '' ? SCHEME_DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
  return port === undefined ? undefined : { host: parsed.hostname, port };
}

function redisService(): StackService | undefined {
  const config = getRedisConfig();
  if (config.url !== undefined) return serviceAt(config.url);
  return {
    host: config.host ?? LOOPBACK_ADDRESS,
    port: config.port ?? REDIS_DEFAULT_PORT,
  };
}

/**
 * Redis as the lane connects to it; the database and the API where the lane's
 * environment names them, else on loopback at the ports the stack publishes;
 * and the web application at its port.
 */
export function stackServicesOf(): StackService[] {
  const env = process.env;
  const services: Array<StackService | undefined> = [
    redisService(),
    serviceAt(env['DATABASE_URL']) ?? {
      host: LOOPBACK_ADDRESS,
      port: STACK_DATABASE_PORT_DEFAULT,
    },
    serviceAt(env['AFLOW_API_URL']) ?? {
      host: LOOPBACK_ADDRESS,
      port: STACK_API_PORT_DEFAULT,
    },
    { host: LOOPBACK_ADDRESS, port: STACK_WEB_PORT_DEFAULT },
  ];
  return services.filter((service): service is StackService => service !== undefined);
}

function spelledForPolicy(host: string): string {
  const bare = unbracketed(host);
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

/**
 * `deniedDomains` entries for each service: one on this machine under every
 * loopback spelling, one elsewhere under the host it is reached by.
 */
export function stackServiceDenials(services: readonly StackService[]): string[] {
  const entries = services.flatMap((service) =>
    (isLoopbackHost(service.host) ? LOOPBACK_SPELLINGS : [spelledForPolicy(service.host)]).map(
      (host) => `${host}:${String(service.port)}`,
    ),
  );
  return [...new Set(entries)];
}
