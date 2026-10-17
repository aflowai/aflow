/**
 * The workspace asking one machine's executor for something and waiting for
 * its answer: a request published on the machine's own channel, answered on a
 * channel named for the request.
 */
import { randomBytes } from 'node:crypto';

/** The connections the exchange runs on: a subscriber of its own, and any client to publish with. */
export interface HostExchangeConnections {
  publish(channel: string, message: string): Promise<number>;
  subscriber(): {
    on(event: 'message', listener: (channel: string, message: string) => void): unknown;
    subscribe(channel: string): Promise<unknown>;
    disconnect(): void;
  };
}

export type HostExchange<A> =
  | { readonly status: 'answered'; readonly answer: A }
  /** Nobody subscribes to the machine's channel: no executor of it is running. */
  | { readonly status: 'not_listening' }
  | { readonly status: 'no_answer' };

export function newHostAnswerId(): string {
  return randomBytes(18).toString('base64url');
}

export async function askHost<A>(
  connections: HostExchangeConnections,
  exchange: {
    requestChannel: string;
    answerChannel: string;
    request: unknown;
    /** The answer, or undefined for a message that is not one. */
    parse: (value: unknown) => A | undefined;
    timeoutMs: number;
  },
): Promise<HostExchange<A>> {
  const answers = connections.subscriber();
  let timer: NodeJS.Timeout | undefined;
  try {
    const answered = new Promise<A | undefined>((resolve) => {
      answers.on('message', (from: string, raw: string) => {
        if (from !== exchange.answerChannel) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        const answer = exchange.parse(parsed);
        if (answer !== undefined) resolve(answer);
      });
      timer = setTimeout(() => {
        resolve(undefined);
      }, exchange.timeoutMs);
    });
    // Subscribed before the request goes out, so an executor that answers at
    // once is heard.
    await answers.subscribe(exchange.answerChannel);
    const receivers = await connections.publish(
      exchange.requestChannel,
      JSON.stringify(exchange.request),
    );
    if (receivers === 0) return { status: 'not_listening' };
    const answer = await answered;
    return answer === undefined ? { status: 'no_answer' } : { status: 'answered', answer };
  } finally {
    clearTimeout(timer);
    answers.disconnect();
  }
}
