import { describe, it, expect } from 'vitest';
import { parseArxivAtomFeed } from './arxivAtom.js';

/** A trimmed real-shape arXiv API response (namespaces, OpenSearch counters, two entries). */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3Dall%3Atransformer" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=all:transformer</title>
  <id>http://arxiv.org/api/cHxbiOdZaP56ODnBPIenZhzg5f8</id>
  <updated>2026-07-26T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">835</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <opensearch:itemsPerPage xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">25</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
  You Need</title>
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks that include an encoder and a decoder.
</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">15 pages</arxiv:comment>
    <link href="http://arxiv.org/abs/1706.03762v7" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <updated>2021-01-01T10:00:00Z</updated>
    <published>2021-01-01T10:00:00Z</published>
    <title>A Minimal Entry</title>
    <summary>Short abstract.</summary>
    <author><name>Solo Author</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/example.doi</arxiv:doi>
    <link href="http://arxiv.org/abs/2101.00001v1" rel="alternate" type="text/html"/>
    <category term="math.CO" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe('parseArxivAtomFeed', () => {
  it('extracts pagination counters and one record per entry, preserving order', () => {
    const result = parseArxivAtomFeed(FEED);
    expect(result.totalResults).toBe(835);
    expect(result.startIndex).toBe(0);
    expect(result.itemsPerPage).toBe(25);
    expect(result.papers.map((p) => p.arxivId)).toEqual(['1706.03762v7', '2101.00001v1']);
  });

  it('collapses formatting whitespace in titles and abstracts without truncating', () => {
    const [first] = parseArxivAtomFeed(FEED).papers;
    expect(first!.title).toBe('Attention Is All You Need');
    expect(first!.abstract).toBe(
      'The dominant sequence transduction models are based on complex recurrent or ' +
        'convolutional neural networks that include an encoder and a decoder.',
    );
  });

  it('collects all authors and categories with the primary category first', () => {
    const [first] = parseArxivAtomFeed(FEED).papers;
    expect(first!.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(first!.categories).toEqual(['cs.CL', 'cs.LG']);
  });

  it('prefers the abstract link, carries the pdf link, and tolerates optional doi/pdf', () => {
    const [first, second] = parseArxivAtomFeed(FEED).papers;
    expect(first!.abstractUrl).toBe('http://arxiv.org/abs/1706.03762v7');
    expect(first!.pdfUrl).toBe('http://arxiv.org/pdf/1706.03762v7');
    expect(first!.doi).toBeUndefined();
    expect(second!.pdfUrl).toBeUndefined();
    expect(second!.doi).toBe('10.1000/example.doi');
    expect(second!.published).toBe('2021-01-01T10:00:00Z');
  });

  it('an empty result feed yields an empty papers array', () => {
    const empty = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;
    const result = parseArxivAtomFeed(empty);
    expect(result.papers).toEqual([]);
    expect(result.totalResults).toBe(0);
  });

  it('tolerates a prefixed Atom namespace on the feed itself', () => {
    const prefixed = `<?xml version="1.0"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom">
  <atom:entry>
    <atom:id>http://arxiv.org/abs/2202.02222v2</atom:id>
    <atom:title>Prefixed Entry</atom:title>
    <atom:summary>Abstract text.</atom:summary>
    <atom:author><atom:name>An Author</atom:name></atom:author>
  </atom:entry>
</atom:feed>`;
    const result = parseArxivAtomFeed(prefixed);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]!.arxivId).toBe('2202.02222v2');
    expect(result.papers[0]!.authors).toEqual(['An Author']);
    // No explicit abstract link — falls back to the entry id URL.
    expect(result.papers[0]!.abstractUrl).toBe('http://arxiv.org/abs/2202.02222v2');
  });

  it('does not coerce numeric-looking titles', () => {
    const numeric = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2303.03333v1</id>
    <title>1234</title>
    <summary>All digits.</summary>
  </entry>
</feed>`;
    expect(parseArxivAtomFeed(numeric).papers[0]!.title).toBe('1234');
  });

  it('throws on malformed XML', () => {
    expect(() => parseArxivAtomFeed('<feed><entry></feed>')).toThrow(/invalid XML/);
  });

  it('rejects DOCTYPE declarations (entity-amplification guard)', () => {
    const bomb = `<?xml version="1.0"?>
<!DOCTYPE feed [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>x</id><title>&b;</title></entry></feed>`;
    expect(() => parseArxivAtomFeed(bomb)).toThrow(/DOCTYPE/);
  });

  it('still expands predefined entities in real feed content', () => {
    const feed = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2404.04444v1</id>
    <title>Q&amp;A over Knowledge &lt;Graphs&gt;</title>
    <summary>Uses &amp; symbols.</summary>
  </entry>
</feed>`;
    expect(parseArxivAtomFeed(feed).papers[0]!.title).toBe('Q&A over Knowledge <Graphs>');
  });

  it('throws on a non-Atom document', () => {
    expect(() => parseArxivAtomFeed('<html><body>rate limited</body></html>')).toThrow(
      /no Atom <feed> root/,
    );
  });
});
