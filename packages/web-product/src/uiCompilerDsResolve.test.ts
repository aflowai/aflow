/**
 * The compiler resolves the design-system specifier applet source imports, and
 * does not resolve the retired scope. The shim matches it with a regex, which a
 * search for the literal specifier does not find.
 */
import { describe, expect, it } from 'vitest';

import { compile } from './uiCompiler.js';

/** What an applet's view source opens with, reduced to the one line under test. */
const APPLET_SOURCE = `
import { Badge, Button, Card, Column, Heading, Panel, Row, Text } from '@aflow/design-system';

export default function View() {
  return (
    <Panel>
      <Column gap="sm">
        <Heading>It compiled</Heading>
        <Row gap="sm">
          <Badge>ok</Badge>
          <Button>Go</Button>
        </Row>
        <Card>
          <Text>Body</Text>
        </Card>
      </Column>
    </Panel>
  );
}
`;

const CHARTS_SOURCE = `
import { LineChart } from '@aflow/design-system/charts';

export default function View() {
  return <LineChart data={[]} />;
}
`;

describe('the design-system specifier applet source imports', () => {
  it('resolves, so an applet compiles', async () => {
    const out = await compile(APPLET_SOURCE, 'react_tsx');
    expect(typeof out).toBe('object');
    // The shim is inlined rather than left as a bare import, which is what makes
    // the bundle standalone in the browser.
    expect(JSON.stringify(out)).not.toContain('@aflow/design-system');
  });

  it('resolves the charts subpath too', async () => {
    const out = await compile(CHARTS_SOURCE, 'react_tsx');
    expect(typeof out).toBe('object');
  });

  /**
   * The negative case, and the one that would have caught a stale filter: the old
   * scope must NOT resolve. If it did, the filter would be matching both and the
   * rename would be half-applied without anything failing.
   */
  it('does not resolve the retired scope', async () => {
    const stale = APPLET_SOURCE.replace('@aflow/design-system', '@phoenix/design-system');
    await expect(compile(stale, 'react_tsx')).rejects.toBeDefined();
  });
});
