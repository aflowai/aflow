import {
  createSubscriberConnection,
  getRedisConfig,
  getRedisConnection,
  type HostExchangeConnections,
} from '@aflow/redis';

/** The server's own connections for asking a machine's executor something. */
export function hostExchangeConnections(connectionName: string): HostExchangeConnections {
  return {
    publish: (channel, message) => getRedisConnection().publish(channel, message),
    subscriber: () => createSubscriberConnection({ ...getRedisConfig(), connectionName }),
  };
}
