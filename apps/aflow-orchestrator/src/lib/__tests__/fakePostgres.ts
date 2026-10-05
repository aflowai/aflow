/**
 * A Postgres backend in memory, as much of the wire protocol as postgres.js
 * needs for statements without parameters, handed to the client through its
 * `socket` option so no test needs a listener or a database.
 *
 * `severOn` drops the connection the moment the client sends a statement it
 * matches — before any reply, the way a database that restarts mid-write does.
 */
import { Duplex } from 'node:stream';

export interface FakePostgres {
  /** The client's `socket` option. */
  socket: () => Duplex;
  /** Drops the connection on the next statement `pattern` matches. */
  severOn: (pattern: RegExp) => void;
  readonly connections: number;
}

const STARTUP_HEADER_BYTES = 8;
const MESSAGE_HEADER_BYTES = 5;

function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(MESSAGE_HEADER_BYTES);
  header.write(type, 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

function cstring(text: string): Buffer {
  return Buffer.from(`${text}\0`);
}

export function fakePostgres(): FakePostgres {
  let connections = 0;
  let sever: RegExp | null = null;

  function socket(): Duplex {
    connections += 1;
    let pending = Buffer.alloc(0);
    let started = false;
    let transaction = 'I';

    /** Whether the statement drops the connection, after tracking its effect on the transaction. */
    const statement = (text: string): boolean => {
      if (sever?.test(text) === true) {
        sever = null;
        return true;
      }
      if (/^begin/i.test(text)) transaction = 'T';
      if (/^(commit|rollback)/i.test(text)) transaction = 'I';
      return false;
    };

    const duplex: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        pending = Buffer.concat([pending, chunk]);
        const replies: Buffer[] = [];
        let severed = false;
        while (!severed) {
          if (!started) {
            if (pending.length < STARTUP_HEADER_BYTES) break;
            const length = pending.readInt32BE(0);
            if (pending.length < length) break;
            pending = pending.subarray(length);
            started = true;
            const authenticationOk = Buffer.alloc(4);
            replies.push(message('R', authenticationOk), message('Z', Buffer.from(transaction)));
            continue;
          }
          if (pending.length < MESSAGE_HEADER_BYTES) break;
          const type = String.fromCharCode(pending[0] ?? 0);
          const length = pending.readInt32BE(1);
          if (pending.length < length + 1) break;
          const body = pending.subarray(MESSAGE_HEADER_BYTES, length + 1);
          pending = pending.subarray(length + 1);

          if (type === 'Q') {
            const text = body.subarray(0, body.indexOf(0)).toString();
            severed = statement(text);
            const tag = (text.split(' ')[0] ?? '').toUpperCase();
            replies.push(message('C', cstring(tag)), message('Z', Buffer.from(transaction)));
          } else if (type === 'P') {
            const nameEnd = body.indexOf(0);
            severed = statement(
              body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString(),
            );
            replies.push(message('1'));
          } else if (type === 'B') {
            replies.push(message('2'));
          } else if (type === 'D') {
            const preparedStatement = body[0] === 'S'.charCodeAt(0);
            if (preparedStatement) replies.push(message('t', Buffer.from([0, 0])));
            replies.push(message('n'));
          } else if (type === 'E') {
            replies.push(message('C', cstring('SELECT 0')));
          } else if (type === 'S') {
            replies.push(message('Z', Buffer.from(transaction)));
          }
        }
        // A real socket delivers on a later tick, and postgres.js depends on it:
        // a reply delivered inside its own write lands before it clears its buffer.
        process.nextTick(() => {
          if (severed) {
            duplex.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          } else if (replies.length > 0) {
            duplex.push(Buffer.concat(replies));
          }
        });
        done();
      },
    });
    return Object.assign(duplex, { readyState: 'open', setKeepAlive: () => duplex });
  }

  return {
    socket,
    severOn: (pattern) => {
      sever = pattern;
    },
    get connections() {
      return connections;
    },
  };
}
