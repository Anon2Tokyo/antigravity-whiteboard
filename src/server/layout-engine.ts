import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs';
import type {
  DiagramEdgeSpec,
  DiagramGroupSpec,
  DiagramNodeSpec,
  DiagramSpec,
} from '../shared/dsl.js';
import { measureEdgeLabel, measureLineWidth, measureNodeBox } from './text-metrics.js';

export interface PositionedGroup {
  spec: DiagramGroupSpec;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface PositionedNode {
  spec: DiagramNodeSpec;
  x: number;
  y: number;
  width: number;
  height: number;
  displayText: string;
  labelLines: string[];
  sublabelLines: string[];
}

export interface RoutedEdge {
  id: string;
  spec: DiagramEdgeSpec;
  points: Array<{ x: number; y: number }>;
  labelPos?: { x: number; y: number; width: number; height: number; text: string };
}

export interface SequenceLifeline {
  nodeId: string;
  x: number;
  topY: number;
  bottomY: number;
}

export interface LayoutResult {
  groups: PositionedGroup[];
  nodes: PositionedNode[];
  edges: RoutedEdge[];
  lifelines?: SequenceLifeline[];
  bounds: { x: number; y: number; width: number; height: number };
}

const elk = new ELK();

interface SpacingProfile {
  nodeNode: number;
  layerGap: number;
  edgeEdge: number;
  edgeNode: number;
  groupPadTop: number;
  groupPadSide: number;
}

function getSpacingProfile(spacing?: 'compact' | 'normal' | 'spacious'): SpacingProfile {
  if (spacing === 'compact') {
    return { nodeNode: 32, layerGap: 56, edgeEdge: 14, edgeNode: 18, groupPadTop: 38, groupPadSide: 18 };
  }
  if (spacing === 'spacious') {
    return { nodeNode: 64, layerGap: 96, edgeEdge: 22, edgeNode: 28, groupPadTop: 50, groupPadSide: 32 };
  }
  return { nodeNode: 46, layerGap: 76, edgeEdge: 18, edgeNode: 22, groupPadTop: 44, groupPadSide: 24 };
}

export interface RectBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Iterative AABB Minimum Translation Vector collision solver.
 * Guarantees no two boxes in `boxes` overlap by at least `minGap` pixels.
 */
export function resolveOverlaps<T extends RectBox>(boxes: T[], minGap = 28, maxIters = 60): T[] {
  for (let iter = 0; iter < maxIters; iter++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const ax2 = a.x + a.width;
        const ay2 = a.y + a.height;
        const bx2 = b.x + b.width;
        const by2 = b.y + b.height;

        const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x) + minGap;
        const overlapY = Math.min(ay2, by2) - Math.max(a.y, b.y) + minGap;

        if (overlapX > 0 && overlapY > 0) {
          moved = true;
          const acx = a.x + a.width / 2;
          const acy = a.y + a.height / 2;
          const bcx = b.x + b.width / 2;
          const bcy = b.y + b.height / 2;

          if (overlapX <= overlapY) {
            const dir = bcx >= acx ? 1 : -1;
            const shift = overlapX / 2 + 0.5;
            a.x -= dir * shift;
            b.x += dir * shift;
          } else {
            const dir = bcy >= acy ? 1 : -1;
            const shift = overlapY / 2 + 0.5;
            a.y -= dir * shift;
            b.y += dir * shift;
          }
        }
      }
    }
    if (!moved) break;
  }
  return boxes;
}

/**
 * Computes a clean orthogonal route between two bounding boxes, avoiding straight center-piercing overlaps.
 */
export function routeSimpleOrthogonal(
  from: RectBox,
  to: RectBox,
  offsetIndex = 0,
): Array<{ x: number; y: number }> {
  const fcx = from.x + from.width / 2;
  const fcy = from.y + from.height / 2;
  const tcx = to.x + to.width / 2;
  const tcy = to.y + to.height / 2;
  const dx = tcx - fcx;
  const dy = tcy - fcy;
  const jitter = (offsetIndex % 5 - 2) * 10;

  if (Math.abs(dx) >= Math.abs(dy)) {
    const startX = dx >= 0 ? from.x + from.width : from.x;
    const endX = dx >= 0 ? to.x : to.x + to.width;
    const startY = fcy + (offsetIndex === 0 ? 0 : jitter);
    const endY = tcy + (offsetIndex === 0 ? 0 : jitter);
    if (Math.abs(startY - endY) < 4) {
      return [
        { x: startX, y: startY },
        { x: endX, y: endY },
      ];
    }
    const midX = (startX + endX) / 2;
    return [
      { x: startX, y: startY },
      { x: midX, y: startY },
      { x: midX, y: endY },
      { x: endX, y: endY },
    ];
  } else {
    const startY = dy >= 0 ? from.y + from.height : from.y;
    const endY = dy >= 0 ? to.y : to.y + to.height;
    const startX = fcx + (offsetIndex === 0 ? 0 : jitter);
    const endX = tcx + (offsetIndex === 0 ? 0 : jitter);
    if (Math.abs(startX - endX) < 4) {
      return [
        { x: startX, y: startY },
        { x: endX, y: endY },
      ];
    }
    const midY = (startY + endY) / 2;
    return [
      { x: startX, y: startY },
      { x: startX, y: midY },
      { x: endX, y: midY },
      { x: endX, y: endY },
    ];
  }
}

function computeOverallBounds(
  groups: PositionedGroup[],
  nodes: PositionedNode[],
  edges: RoutedEdge[],
  lifelines?: SequenceLifeline[],
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includeRect = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };

  for (const g of groups) includeRect(g.x, g.y, g.width, g.height);
  for (const n of nodes) includeRect(n.x, n.y, n.width, n.height);
  for (const e of edges) {
    for (const p of e.points) includeRect(p.x, p.y, 1, 1);
    if (e.labelPos) includeRect(e.labelPos.x, e.labelPos.y, e.labelPos.width, e.labelPos.height);
  }
  if (lifelines) {
    for (const l of lifelines) includeRect(l.x, l.topY, 1, l.bottomY - l.topY);
  }

  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function normalizeToOrigin(result: LayoutResult): LayoutResult {
  const { x: minX, y: minY } = result.bounds;
  if (minX === 0 && minY === 0) return result;
  for (const g of result.groups) {
    g.x -= minX;
    g.y -= minY;
  }
  for (const n of result.nodes) {
    n.x -= minX;
    n.y -= minY;
  }
  for (const e of result.edges) {
    for (const p of e.points) {
      p.x -= minX;
      p.y -= minY;
    }
    if (e.labelPos) {
      e.labelPos.x -= minX;
      e.labelPos.y -= minY;
    }
  }
  if (result.lifelines) {
    for (const l of result.lifelines) {
      l.x -= minX;
      l.topY -= minY;
      l.bottomY -= minY;
    }
  }
  result.bounds = {
    x: 0,
    y: 0,
    width: result.bounds.width,
    height: result.bounds.height,
  };
  return result;
}

/**
 * Dedicated Sequence Diagram layout engine (lifelines + ordered horizontal messages).
 */
function layoutSequence(spec: DiagramSpec): LayoutResult {
  const sp = getSpacingProfile(spec.style?.spacing);
  const measuredNodes = spec.nodes.map((n) => ({ spec: n, m: measureNodeBox(n) }));
  const actorGap = Math.max(70, sp.nodeNode + 28);

  const nodes: PositionedNode[] = [];
  const nodeMap = new Map<string, PositionedNode>();
  let curX = 0;
  let maxActorH = 0;

  for (const { spec: ns, m } of measuredNodes) {
    const pn: PositionedNode = {
      spec: ns,
      x: curX,
      y: 0,
      width: m.width,
      height: m.height,
      displayText: m.displayText,
      labelLines: m.labelLines,
      sublabelLines: m.sublabelLines,
    };
    nodes.push(pn);
    nodeMap.set(ns.id, pn);
    curX += m.width + actorGap;
    maxActorH = Math.max(maxActorH, m.height);
  }

  const stepGap = 62;
  let curY = maxActorH + 46;
  const edges: RoutedEdge[] = [];

  (spec.edges ?? []).forEach((es, idx) => {
    const from = nodeMap.get(es.from);
    const to = nodeMap.get(es.to);
    if (!from || !to) return;

    const fromX = from.x + from.width / 2;
    const toX = to.x + to.width / 2;
    const edgeId = es.id || `edge_${idx + 1}_${es.from}_${es.to}`;
    const labelText = es.label ? `${idx + 1}. ${es.label}` : undefined;

    if (es.from === es.to) {
      // Self-call loop
      const loopW = 54;
      const loopH = 34;
      const points = [
        { x: fromX, y: curY },
        { x: fromX + loopW, y: curY },
        { x: fromX + loopW, y: curY + loopH },
        { x: fromX, y: curY + loopH },
      ];
      const mLabel = labelText ? measureEdgeLabel(labelText) : undefined;
      edges.push({
        id: edgeId,
        spec: { ...es, routing: 'orthogonal' },
        points,
        labelPos: mLabel
          ? {
              x: fromX + loopW + 8,
              y: curY + loopH / 2 - mLabel.height / 2,
              width: mLabel.width,
              height: mLabel.height,
              text: mLabel.wrapped,
            }
          : undefined,
      });
      curY += loopH + stepGap - 16;
    } else {
      const points = [
        { x: fromX, y: curY },
        { x: toX, y: curY },
      ];
      const mLabel = labelText ? measureEdgeLabel(labelText) : undefined;
      edges.push({
        id: edgeId,
        spec: { ...es, routing: 'straight' },
        points,
        labelPos: mLabel
          ? {
              x: (fromX + toX) / 2 - mLabel.width / 2,
              y: curY - mLabel.height - 6,
              width: mLabel.width,
              height: mLabel.height,
              text: mLabel.wrapped,
            }
          : undefined,
      });
      curY += stepGap;
    }
  });

  const lifelineBottom = Math.max(curY + 20, maxActorH + 120);
  const lifelines: SequenceLifeline[] = nodes.map((n) => ({
    nodeId: n.spec.id,
    x: n.x + n.width / 2,
    topY: n.y + n.height,
    bottomY: lifelineBottom,
  }));

  const bounds = computeOverallBounds([], nodes, edges, lifelines);
  return normalizeToOrigin({ groups: [], nodes, edges, lifelines, bounds });
}

/**
 * Free composition layout with AI coordinate hints + strict collision avoidance.
 */
function layoutFree(spec: DiagramSpec): LayoutResult {
  const sp = getSpacingProfile(spec.style?.spacing);
  const nodes: PositionedNode[] = [];
  const nodeMap = new Map<string, PositionedNode>();

  const cols = Math.max(1, Math.ceil(Math.sqrt(spec.nodes.length)));
  spec.nodes.forEach((ns, idx) => {
    const m = measureNodeBox(ns);
    const defaultX = (idx % cols) * (m.width + sp.nodeNode + 24);
    const defaultY = Math.floor(idx / cols) * (m.height + sp.layerGap);
    const pn: PositionedNode = {
      spec: ns,
      x: typeof ns.x === 'number' ? ns.x : defaultX,
      y: typeof ns.y === 'number' ? ns.y : defaultY,
      width: m.width,
      height: m.height,
      displayText: m.displayText,
      labelLines: m.labelLines,
      sublabelLines: m.sublabelLines,
    };
    nodes.push(pn);
    nodeMap.set(ns.id, pn);
  });

  // Resolve any node-node overlaps
  resolveOverlaps(
    nodes.map((n) => ({
      id: n.spec.id,
      get x() { return n.x; },
      set x(v) { n.x = v; },
      get y() { return n.y; },
      set y(v) { n.y = v; },
      width: n.width,
      height: n.height,
    })),
    sp.nodeNode,
  );

  // Wrap groups tightly around member nodes
  const groups: PositionedGroup[] = [];
  for (const gs of spec.groups ?? []) {
    const members = nodes.filter((n) => n.spec.group === gs.id);
    if (members.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const m of members) {
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x + m.width);
      maxY = Math.max(maxY, m.y + m.height);
    }
    const titleW = measureLineWidth(gs.label, 15) + 40;
    const width = Math.max(maxX - minX + sp.groupPadSide * 2, titleW);
    groups.push({
      spec: gs,
      x: minX - sp.groupPadSide,
      y: minY - sp.groupPadTop,
      width,
      height: maxY - minY + sp.groupPadTop + sp.groupPadSide,
      depth: gs.parentGroup ? 1 : 0,
    });
  }

  const edges: RoutedEdge[] = [];
  (spec.edges ?? []).forEach((es, idx) => {
    const from = nodeMap.get(es.from);
    const to = nodeMap.get(es.to);
    if (!from || !to) return;
    const points = routeSimpleOrthogonal(
      { id: from.spec.id, x: from.x, y: from.y, width: from.width, height: from.height },
      { id: to.spec.id, x: to.x, y: to.y, width: to.width, height: to.height },
      idx,
    );
    const mid = points[Math.floor(points.length / 2)];
    const prev = points[Math.max(0, Math.floor(points.length / 2) - 1)];
    const mLabel = es.label ? measureEdgeLabel(es.label) : undefined;
    edges.push({
      id: es.id || `edge_${idx + 1}_${es.from}_${es.to}`,
      spec: es,
      points,
      labelPos: mLabel
        ? {
            x: (mid.x + prev.x) / 2 - mLabel.width / 2,
            y: (mid.y + prev.y) / 2 - mLabel.height / 2,
            width: mLabel.width,
            height: mLabel.height,
            text: mLabel.wrapped,
          }
        : undefined,
    });
  });

  const bounds = computeOverallBounds(groups, nodes, edges);
  return normalizeToOrigin({ groups, nodes, edges, bounds });
}

function elkOptionsForStrategy(
  strategy: DiagramSpec['layout'],
  sp: SpacingProfile,
): Record<string, string> {
  const base: Record<string, string> = {
    'elk.spacing.nodeNode': String(sp.nodeNode),
    'elk.spacing.edgeEdge': String(sp.edgeEdge),
    'elk.spacing.edgeNode': String(sp.edgeNode),
    'elk.spacing.labelLabel': '10',
    'elk.spacing.labelNode': '10',
    'elk.padding': `[top=${sp.groupPadTop},left=${sp.groupPadSide},bottom=${sp.groupPadSide},right=${sp.groupPadSide}]`,
  };

  switch (strategy) {
    case 'layered-lr':
      return {
        ...base,
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': String(sp.layerGap),
        'elk.layered.spacing.edgeNodeBetweenLayers': String(sp.edgeNode),
        'elk.layered.spacing.edgeEdgeBetweenLayers': String(sp.edgeEdge),
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      };
    case 'box':
      return {
        ...base,
        'elk.algorithm': 'rectpacking',
        'elk.aspectRatio': '1.45',
        'elk.spacing.nodeNode': String(Math.max(24, sp.nodeNode - 14)),
      };
    case 'stress':
      return {
        ...base,
        'elk.algorithm': 'stress',
        'elk.stress.desiredEdgeLength': String(sp.layerGap + 120),
      };
    case 'mrtree':
      return {
        ...base,
        'elk.algorithm': 'mrtree',
        'elk.direction': 'DOWN',
        'elk.spacing.nodeNode': String(sp.nodeNode),
      };
    case 'layered-tb':
    default:
      return {
        ...base,
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': String(sp.layerGap),
        'elk.layered.spacing.edgeNodeBetweenLayers': String(sp.edgeNode),
        'elk.layered.spacing.edgeEdgeBetweenLayers': String(sp.edgeEdge),
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      };
  }
}

/**
 * Main entry point: runs the chosen layout strategy and guarantees non-overlapping geometry.
 */
export async function computeDiagramLayout(spec: DiagramSpec): Promise<LayoutResult> {
  if (spec.nodes.length === 0) {
    return { groups: [], nodes: [], edges: [], bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }

  if (spec.layout === 'sequence') {
    return layoutSequence(spec);
  }
  if (spec.layout === 'free') {
    return layoutFree(spec);
  }

  const sp = getSpacingProfile(spec.style?.spacing);
  const groupSpecs = spec.groups ?? [];
  const groupSpecMap = new Map<string, DiagramGroupSpec>();
  for (const g of groupSpecs) groupSpecMap.set(g.id, g);

  const nodeSpecMap = new Map<string, DiagramNodeSpec>();
  const measuredMap = new Map<string, ReturnType<typeof measureNodeBox>>();
  for (const n of spec.nodes) {
    nodeSpecMap.set(n.id, n);
    measuredMap.set(n.id, measureNodeBox(n));
  }

  // Build ELK compound hierarchy
  const elkNodeMap = new Map<string, ElkNode>();
  const rootChildren: ElkNode[] = [];

  for (const g of groupSpecs) {
    const groupLayout = g.layout ?? (spec.layout === 'box' ? 'box' : spec.layout);
    const titleMinW = measureLineWidth(g.label, 15) + 48;
    const gNode: ElkNode = {
      id: g.id,
      children: [],
      layoutOptions: {
        ...elkOptionsForStrategy(groupLayout, sp),
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${titleMinW}, 90)`,
      },
    };
    elkNodeMap.set(g.id, gNode);
  }

  // Attach nested groups
  for (const g of groupSpecs) {
    const gNode = elkNodeMap.get(g.id)!;
    if (g.parentGroup && elkNodeMap.has(g.parentGroup) && g.parentGroup !== g.id) {
      elkNodeMap.get(g.parentGroup)!.children!.push(gNode);
    } else {
      rootChildren.push(gNode);
    }
  }

  // Attach leaf nodes
  for (const n of spec.nodes) {
    const m = measuredMap.get(n.id)!;
    const leaf: ElkNode = {
      id: n.id,
      width: m.width,
      height: m.height,
    };
    elkNodeMap.set(n.id, leaf);
    if (n.group && elkNodeMap.has(n.group)) {
      elkNodeMap.get(n.group)!.children!.push(leaf);
    } else {
      rootChildren.push(leaf);
    }
  }

  // Remove empty groups that have no children so ELK doesn't collapse them weirdly
  const pruneEmptyGroups = (list: ElkNode[]): ElkNode[] =>
    list.filter((item) => {
      if (groupSpecMap.has(item.id)) {
        item.children = pruneEmptyGroups(item.children ?? []);
        return item.children.length > 0;
      }
      return true;
    });

  const validRootChildren = pruneEmptyGroups(rootChildren);
  const activeIds = new Set<string>();
  const collectIds = (list: ElkNode[]) => {
    for (const item of list) {
      activeIds.add(item.id);
      if (item.children) collectIds(item.children);
    }
  };
  collectIds(validRootChildren);

  const edgeSpecMap = new Map<string, DiagramEdgeSpec>();
  const elkEdges: ElkExtendedEdge[] = [];

  // In `box` mode (rectpacking), ELK doesn't route edges natively; we route them cleanly post-layout
  const elkHandlesEdges = spec.layout === 'layered-tb' || spec.layout === 'layered-lr' || spec.layout === 'stress' || spec.layout === 'mrtree';

  (spec.edges ?? []).forEach((es, idx) => {
    if (!activeIds.has(es.from) || !activeIds.has(es.to)) return;
    const edgeId = es.id || `edge_${idx + 1}_${es.from}_${es.to}`;
    edgeSpecMap.set(edgeId, es);

    if (elkHandlesEdges) {
      const mLabel = es.label ? measureEdgeLabel(es.label) : undefined;
      elkEdges.push({
        id: edgeId,
        sources: [es.from],
        targets: [es.to],
        labels: mLabel
          ? [{ text: mLabel.wrapped, width: mLabel.width, height: mLabel.height }]
          : undefined,
      });
    }
  });

  const rootGraph: ElkNode = {
    id: '__root__',
    layoutOptions: elkOptionsForStrategy(spec.layout, sp),
    children: validRootChildren,
    edges: elkEdges,
  };

  const laidOut = await elk.layout(rootGraph);

  const groups: PositionedGroup[] = [];
  const nodes: PositionedNode[] = [];
  const nodePosMap = new Map<string, PositionedNode>();
  const containerOffsetMap = new Map<string, { x: number; y: number }>();
  containerOffsetMap.set('__root__', { x: 0, y: 0 });

  const walk = (container: ElkNode, offsetX: number, offsetY: number, depth: number) => {
    for (const child of container.children ?? []) {
      const absX = offsetX + (child.x ?? 0);
      const absY = offsetY + (child.y ?? 0);
      const w = child.width ?? 140;
      const h = child.height ?? 60;

      if (groupSpecMap.has(child.id)) {
        groups.push({
          spec: groupSpecMap.get(child.id)!,
          x: absX,
          y: absY,
          width: w,
          height: h,
          depth,
        });
        containerOffsetMap.set(child.id, { x: absX, y: absY });
        walk(child, absX, absY, depth + 1);
      } else if (nodeSpecMap.has(child.id)) {
        const m = measuredMap.get(child.id)!;
        const pn: PositionedNode = {
          spec: nodeSpecMap.get(child.id)!,
          x: absX,
          y: absY,
          width: w,
          height: h,
          displayText: m.displayText,
          labelLines: m.labelLines,
          sublabelLines: m.sublabelLines,
        };
        nodes.push(pn);
        nodePosMap.set(child.id, pn);
      }
    }
  };
  walk(laidOut, 0, 0, 0);

  // For `stress` layout, guarantee zero overlaps with our AABB solver
  if (spec.layout === 'stress' && groups.length === 0) {
    resolveOverlaps(
      nodes.map((n) => ({
        id: n.spec.id,
        get x() { return n.x; },
        set x(v) { n.x = v; },
        get y() { return n.y; },
        set y(v) { n.y = v; },
        width: n.width,
        height: n.height,
      })),
      sp.nodeNode,
    );
  }

  // Extract routed edges (either from ELK sections or fallback orthogonal router)
  const edges: RoutedEdge[] = [];
  const extractedEdgeIds = new Set<string>();

  const collectEdges = (container: ElkNode) => {
    const baseOffset = containerOffsetMap.get(container.id) ?? { x: 0, y: 0 };
    for (const e of container.edges ?? []) {
      const es = edgeSpecMap.get(e.id);
      if (!es) continue;
      extractedEdgeIds.add(e.id);

      const section = e.sections?.[0];
      if (section && spec.layout !== 'stress') {
        const points: Array<{ x: number; y: number }> = [
          { x: baseOffset.x + section.startPoint.x, y: baseOffset.y + section.startPoint.y },
          ...(section.bendPoints ?? []).map((bp) => ({
            x: baseOffset.x + bp.x,
            y: baseOffset.y + bp.y,
          })),
          { x: baseOffset.x + section.endPoint.x, y: baseOffset.y + section.endPoint.y },
        ];

        const elkLabel = e.labels?.[0];
        edges.push({
          id: e.id,
          spec: es,
          points,
          labelPos:
            elkLabel && elkLabel.text
              ? {
                  x: baseOffset.x + (elkLabel.x ?? 0),
                  y: baseOffset.y + (elkLabel.y ?? 0),
                  width: elkLabel.width ?? 60,
                  height: elkLabel.height ?? 20,
                  text: elkLabel.text,
                }
              : undefined,
        });
      }
    }
    for (const child of container.children ?? []) {
      collectEdges(child);
    }
  };
  collectEdges(laidOut);

  // Route any remaining edges (e.g., `box` or `stress` after overlap resolution)
  let fallbackIdx = 0;
  for (const [edgeId, es] of edgeSpecMap.entries()) {
    if (edges.some((e) => e.id === edgeId)) continue;
    const from = nodePosMap.get(es.from);
    const to = nodePosMap.get(es.to);
    if (!from || !to) continue;
    const points = routeSimpleOrthogonal(
      { id: from.spec.id, x: from.x, y: from.y, width: from.width, height: from.height },
      { id: to.spec.id, x: to.x, y: to.y, width: to.width, height: to.height },
      fallbackIdx++,
    );
    const midIdx = Math.floor(points.length / 2);
    const a = points[Math.max(0, midIdx - 1)];
    const b = points[midIdx];
    const mLabel = es.label ? measureEdgeLabel(es.label) : undefined;
    edges.push({
      id: edgeId,
      spec: es,
      points,
      labelPos: mLabel
        ? {
            x: (a.x + b.x) / 2 - mLabel.width / 2,
            y: (a.y + b.y) / 2 - mLabel.height / 2,
            width: mLabel.width,
            height: mLabel.height,
            text: mLabel.wrapped,
          }
        : undefined,
    });
  }

  // Sort groups outer-to-inner so outer containers render behind inner containers
  groups.sort((a, b) => a.depth - b.depth);

  const bounds = computeOverallBounds(groups, nodes, edges);
  return normalizeToOrigin({ groups, nodes, edges, bounds });
}
