/**
 * A coding harness's browser tools, as a stdio MCP server with no browser of
 * its own (Plan 320 D11).
 *
 * The executor copies this file into the run's scratch directory and names it
 * in the MCP configuration the harness is started with, so it runs inside the
 * harness's sandbox, as the harness's child. It answers the handshake and the
 * tool list itself and passes every tool call, unchanged, to the executor over
 * two named pipes in that same directory — newline-delimited JSON, one pipe
 * each way — which is the one route out of the sandbox that needs nothing
 * widened (§8.2). It opens no socket and reads nothing but its tool list.
 *
 * Node's standard library only: it runs from a directory where nothing else
 * of this repository can be resolved.
 *
 * argv: <tools.json> <request pipe> <response pipe>
 */
import { constants, openSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';

const [toolsPath, requestPath, responsePath] = process.argv.slice(2);
if (toolsPath === undefined || requestPath === undefined || responsePath === undefined) {
  process.stderr.write('usage: harnessRelay.mjs <tools.json> <request pipe> <response pipe>\n');
  process.exit(2);
}

/** @type {Array<{ name: string, description: string, inputSchema: object }>} */
const tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
const toolNames = new Set(tools.map((tool) => tool.name));

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const ENDED =
  'The browser is no longer available: the harness run it belonged to has ended, or its ' +
  'executor stopped.';

let toExecutor;
let fromExecutor;
try {
  // Non-blocking, so an executor that is not there is an error now rather
  // than a harness waiting forever on a pipe nobody reads.
  toExecutor = new Socket({
    fd: openSync(requestPath, constants.O_WRONLY | constants.O_NONBLOCK),
    readable: false,
    writable: true,
  });
  fromExecutor = new Socket({
    fd: openSync(responsePath, constants.O_RDONLY | constants.O_NONBLOCK),
    readable: true,
    writable: false,
  });
} catch (error) {
  process.stderr.write(`The browser relay could not reach the executor: ${String(error)}\n`);
  process.exit(1);
}

/** The harness's request id for each call passed on, by the id it was passed on with. */
const pending = new Map();
let nextCallId = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function endedResult() {
  return { content: [{ type: 'text', text: ENDED }], isError: true };
}

function handle(message) {
  if (message === null || typeof message !== 'object') return;
  if (Array.isArray(message)) {
    for (const each of message) handle(each);
    return;
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') return;
  const answers = id !== undefined && id !== null;
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion:
          typeof params?.protocolVersion === 'string'
            ? params.protocolVersion
            : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'aflow-browser', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'ping') {
    if (answers) send({ id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string' || !toolNames.has(name)) {
      send({
        id,
        error: {
          code: -32602,
          message: `No tool \`${String(name)}\`. Tools: ${[...toolNames].join(', ')}.`,
        },
      });
      return;
    }
    if (fromExecutor.destroyed) {
      send({ id, result: endedResult() });
      return;
    }
    nextCallId += 1;
    pending.set(nextCallId, id);
    toExecutor.write(
      `${JSON.stringify({ id: nextCallId, tool: name, arguments: params?.arguments ?? {} })}\n`,
    );
    return;
  }
  if (answers) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function parseLine(line, then) {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  then(message);
}

createInterface({ input: fromExecutor }).on('line', (line) => {
  parseLine(line, (answer) => {
    const id = pending.get(answer?.id);
    if (id === undefined) return;
    pending.delete(answer.id);
    send({ id, result: answer.result ?? endedResult() });
  });
});

function shutDown() {
  for (const id of pending.values()) send({ id, result: endedResult() });
  pending.clear();
  toExecutor.destroy();
  fromExecutor.destroy();
}

fromExecutor.on('close', () => {
  for (const id of pending.values()) send({ id, result: endedResult() });
  pending.clear();
});
toExecutor.on('error', () => undefined);
fromExecutor.on('error', () => undefined);

const harness = createInterface({ input: process.stdin });
harness.on('line', (line) => {
  parseLine(line, handle);
});
harness.on('close', shutDown);
