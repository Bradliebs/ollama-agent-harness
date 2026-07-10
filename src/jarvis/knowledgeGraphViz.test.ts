import type { GraphRecord } from './knowledgeGraph';
import { composeMermaidGraph } from './knowledgeGraphViz';

function entity(id: string, name: string): GraphRecord {
  return { kind: 'entity', id, type: 'file', name, source: 't', observedAt: '2026-05-12T00:00:00Z' };
}
function edge(from: string, to: string, relation: string): GraphRecord {
  return { kind: 'edge', id: `${from}-${to}`, from, to, relation, source: 't', observedAt: '2026-05-12T00:00:00Z' };
}

describe('knowledge graph mermaid', () => {
  it('returns an empty marker for empty input', () => {
    const out = composeMermaidGraph([]);
    expect(out).toMatch(/graph TD/);
    expect(out).toMatch(/empty graph/);
  });

  it('renders nodes and edges', () => {
    const out = composeMermaidGraph([entity('a', 'alpha'), entity('b', 'beta'), edge('a', 'b', 'uses')]);
    expect(out).toMatch(/n_a\["alpha"\]/);
    expect(out).toMatch(/n_b\["beta"\]/);
    expect(out).toMatch(/n_a -->\|uses\| n_b/);
  });

  it('focus filter restricts to one hop', () => {
    const records: GraphRecord[] = [
      entity('a', 'payment'), entity('b', 'auth'), entity('c', 'unrelated'),
      edge('a', 'b', 'depends'), edge('a', 'c', 'depends'),
    ];
    const out = composeMermaidGraph(records, { focus: 'payment' });
    expect(out).toMatch(/payment/);
    expect(out).toMatch(/auth/);
    expect(out).toMatch(/unrelated/); // one hop from focus, still included
  });

  it('focus excludes nodes with no edge to the focus name', () => {
    const records: GraphRecord[] = [entity('a', 'payment'), entity('z', 'isolated')];
    const out = composeMermaidGraph(records, { focus: 'payment' });
    expect(out).not.toMatch(/isolated/);
  });

  it('caps at maximum nodes', () => {
    const records: GraphRecord[] = [];
    for (let i = 0; i < 50; i++) records.push(entity(`e${i}`, `name${i}`));
    const out = composeMermaidGraph(records);
    const nodeLines = out.split('\n').filter((l) => /n_e\d+\["name\d+"\]/.test(l));
    expect(nodeLines.length).toBeLessThanOrEqual(30);
  });
});
