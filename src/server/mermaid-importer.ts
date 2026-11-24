import type {
  DiagramEdgeSpec,
  DiagramGroupSpec,
  DiagramNodeSpec,
  DiagramSpec,
  NodeShape,
} from '../shared/dsl.js';

function parseNodeToken(raw: string): { id: string; label: string; shape: NodeShape } {
  const s = raw.trim();
  // Match shapes: id[(Label)], id((Label)), id{Label}, id([Label]), id(Label), id[Label]
  const patterns: Array<{ re: RegExp; shape: NodeShape }> = [
    { re: /^([A-Za-z0-9_-]+)\s*\[\((.+)\)\]$/, shape: 'database' },
    { re: /^([A-Za-z0-9_-]+)\s*\(\((.+)\)\)$/, shape: 'ellipse' },
    { re: /^([A-Za-z0-9_-]+)\s*\(\[(.+)\]\)$/, shape: 'queue' },
    { re: /^([A-Za-z0-9_-]+)\s*\{(.+)\}$/, shape: 'diamond' },
    { re: /^([A-Za-z0-9_-]+)\s*\((.+)\)$/, shape: 'rounded' },
    { re: /^([A-Za-z0-9_-]+)\s*\[(.+)\]$/, shape: 'rect' },
  ];

  for (const { re, shape } of patterns) {
    const m = s.match(re);
    if (m) {
      const label = m[2].trim().replace(/^["']|["']$/g, '').replace(/<br\s*\/?>/gi, '\n');
      return { id: m[1], label, shape };
    }
  }

  const idOnly = s.replace(/[^A-Za-z0-9_-]/g, '_') || 'node';
  return { id: idOnly, label: s, shape: 'rounded' };
}

/**
 * Lightweight zero-dependency Mermaid importer covering `flowchart`/`graph` (including subgraphs)
 * and `sequenceDiagram`, producing our standard DiagramSpec for ELK anti-overlap layout.
 */
export function parseMermaidToDiagramSpec(mermaid: string): DiagramSpec {
  const lines = mermaid
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));

  if (lines.length === 0) {
    return { layout: 'layered-tb', nodes: [], edges: [] };
  }

  const header = lines[0];

  // Sequence diagram mode
  if (/^sequenceDiagram\b/i.test(header)) {
    const nodeMap = new Map<string, DiagramNodeSpec>();
    const edges: DiagramEdgeSpec[] = [];

    const ensureActor = (id: string, label?: string) => {
      if (!nodeMap.has(id)) {
        nodeMap.set(id, { id, label: label || id, shape: 'rounded' });
      } else if (label) {
        nodeMap.get(id)!.label = label;
      }
    };

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const partMatch = line.match(/^(?:participant|actor)\s+([A-Za-z0-9_-]+)(?:\s+as\s+(.+))?$/i);
      if (partMatch) {
        ensureActor(partMatch[1], partMatch[2]?.trim());
        continue;
      }
      const msgMatch = line.match(/^([A-Za-z0-9_-]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (msgMatch) {
        const [, from, arrow, to, label] = msgMatch;
        ensureActor(from);
        ensureActor(to);
        edges.push({
          from,
          to,
          label: label.trim() || undefined,
          lineStyle: arrow.startsWith('--') ? 'dashed' : 'solid',
        });
      }
    }

    return {
      layout: 'sequence',
      nodes: Array.from(nodeMap.values()),
      edges,
    };
  }

  // Flowchart / graph mode
  let layout: DiagramSpec['layout'] = 'layered-tb';
  const dirMatch = header.match(/^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)\b/i);
  if (dirMatch) {
    const dir = dirMatch[1].toUpperCase();
    if (dir === 'LR' || dir === 'RL') layout = 'layered-lr';
  }

  const groups: DiagramGroupSpec[] = [];
  const groupStack: string[] = [];
  const nodeMap = new Map<string, DiagramNodeSpec>();
  const edges: DiagramEdgeSpec[] = [];

  const upsertNode = (tok: { id: string; label: string; shape: NodeShape }) => {
    const existing = nodeMap.get(tok.id);
    const currentGroup = groupStack[groupStack.length - 1];
    if (!existing) {
      nodeMap.set(tok.id, {
        id: tok.id,
        label: tok.label,
        shape: tok.shape,
        group: currentGroup,
      });
    } else {
      if (tok.label !== tok.id) existing.label = tok.label;
      if (tok.shape !== 'rounded') existing.shape = tok.shape;
      if (!existing.group && currentGroup) existing.group = currentGroup;
    }
  };

  for (let i = dirMatch ? 1 : 0; i < lines.length; i++) {
    const line = lines[i];

    // Subgraph start
    const sgMatch = line.match(/^subgraph\s+([A-Za-z0-9_-]+)(?:\s*\[(.+)\])?$/i);
    if (sgMatch) {
      const gid = sgMatch[1];
      const label = (sgMatch[2] || sgMatch[1]).replace(/^["']|["']$/g, '').trim();
      const parentGroup = groupStack[groupStack.length - 1];
      groups.push({ id: gid, label, parentGroup });
      groupStack.push(gid);
      continue;
    }
    const sgLabelOnly = line.match(/^subgraph\s+["'](.+)["']$/i);
    if (sgLabelOnly) {
      const label = sgLabelOnly[1].trim();
      const gid = `group_${groups.length + 1}`;
      const parentGroup = groupStack[groupStack.length - 1];
      groups.push({ id: gid, label, parentGroup });
      groupStack.push(gid);
      continue;
    }
    if (/^end$/i.test(line)) {
      groupStack.pop();
      continue;
    }
    if (/^(?:style|classDef|class|linkStyle|direction)\b/i.test(line)) {
      continue;
    }

    // Edge syntax: A -->|label| B  OR  A -.->|label| B  OR  A ==>|label| B  OR  A -- label --> B
    const edgeRe = /^(.+?)\s*(==>|-\.->|-->|<-->|---|-\.-)\s*(?:\|([^|]+)\|)?\s*(.+)$/;
    const m = line.match(edgeRe);
    if (m) {
      const [, leftRaw, connector, pipeLabel, rightRaw] = m;
      const fromTok = parseNodeToken(leftRaw);
      const toTok = parseNodeToken(rightRaw);
      upsertNode(fromTok);
      upsertNode(toTok);

      edges.push({
        from: fromTok.id,
        to: toTok.id,
        label: pipeLabel?.trim() || undefined,
        lineStyle: connector.includes('.') ? 'dashed' : 'solid',
        emphasis: connector === '==>' ? 'primary' : 'normal',
        arrows: connector === '<-->' ? 'both' : connector === '---' || connector === '-.-' ? 'none' : 'end',
      });
      continue;
    }

    // Standalone node declaration
    if (/^[A-Za-z0-9_-]+\s*[\[\(\{]/.test(line)) {
      upsertNode(parseNodeToken(line));
    }
  }

  return {
    layout,
    groups: groups.length > 0 ? groups : undefined,
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}
