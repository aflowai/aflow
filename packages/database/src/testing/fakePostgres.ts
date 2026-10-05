/**
 * A Postgres backend in memory, as much of the wire protocol as postgres.js
 * needs for statements without parameters, handed to the client through its
 * `socket` option so no test needs a listener or a database.
 *
 * `severOn` drops the connection the moment the client sends a statement it
 * matches — before any reply, the way a database that restarts mid-write does.
 * `holdOn` keeps a statement running until the test releases it.
 */
import { Duplex } from 'node:stream';

export interface HeldStatement {
  /** Whether the client has sent the statement. */
  readonly received: boolean;
  /** Answers the statement, now or as soon as it arrives. */
  release: () => void;
}

export interface FakePostgres {
  /** The client's `socket` option. */
  socket: () => Duplex;
  /** Drops the connection on the next statement `pattern` matches. */
  severOn: (pattern: RegExp) => void;
  /** Withholds the reply to the next statement `pattern` matches until it is released. */
  holdOn: (pattern: RegExp) => HeldStatement;
  readonly connections: number;
  /** Connections the client has closed itself, with a Terminate message. */
  readonly terminations: number;
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
  let terminations = 0;
  let sever: RegExp | null = null;
  let hold: { pattern: RegExp; answer: (() => void) | null; released: boolean } | null = null;

  function socket(): Duplex {
    connections += 1;
    let pending = Buffer.alloc(0);
    let started = false;
    let transaction = 'I';
    let held = false;
    let terminated = false;

    /** Whether the statement drops the connection, after tracking its effect on the transaction. */
    const statement = (text: string): boolean => {
      if (sever?.test(text) === true) {
        sever = null;
        return true;
      }
      if (hold !== null && hold.answer === null && hold.pattern.test(text)) held = true;
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
        held = false;
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
          } else if (type === 'X') {
            terminated = true;
          }
        }
        const answer = (): void => {
          if (replies.length > 0) duplex.push(Buffer.concat(replies));
        };
        // A real socket delivers on a later tick, and postgres.js depends on it:
        // a reply delivered inside its own write lands before it clears its buffer.
        process.nextTick(() => {
          if (severed) {
            duplex.destroy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
          } else if (held && hold !== null) {
            hold.answer = answer;
            if (hold.released) answer();
          } else {
            answer();
          }
          // The server closes the connection a Terminate asks it to, which is
          // what lets the client see its own close complete.
          if (terminated) duplex.push(null);
        });
        done();
      },
    });
    duplex.on('close', () => {
      if (terminated) terminations += 1;
    });
    return Object.assign(duplex, { readyState: 'open', setKeepAlive: () => duplex });
  }

  return {
    socket,
    severOn: (pattern) => {
      sever = pattern;
    },
    holdOn: (pattern) => {
      const statement = { pattern, answer: null as (() => void) | null, released: false };
      hold = statement;
      return {
        get received() {
          return statement.answer !== null;
        },
        release: () => {
          statement.released = true;
          statement.answer?.();
        },
      };
    },
    get connections() {
      return connections;
    },
    get terminations() {
      return terminations;
    },
  };
}
