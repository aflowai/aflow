/**
 * A real MCP server, small enough to reason about.
 *
 * `read_file` exists to prove confinement: it reads whatever path it is given,
 * so a test can ask it for something outside the binding and see the boundary
 * refuse rather than the server declining.
 */
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });

server.tool('echo', 'Return the text it was given.', { text: z.string() }, ({ text }) => ({
  content: [{ type: 'text', text }],
}));

server.tool(
  'read_file',
  'Read a path, whatever it is. Deliberately unguarded.',
  { path: z.string() },
  ({ path }) => {
    try {
      return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `ERROR ${String(error)}` }], isError: true };
    }
  },
);

server.tool('where', 'Report the working directory.', {}, () => ({
  content: [{ type: 'text', text: process.cwd() }],
}));

await server.connect(new StdioServerTransport());
