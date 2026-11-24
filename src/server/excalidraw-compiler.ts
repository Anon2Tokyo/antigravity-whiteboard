import type {
  DiagramStyleOptions,
  SemanticTone,
} from '../shared/dsl.js';
import type { LayoutResult, PositionedGroup, PositionedNode, RoutedEdge } from './layout-engine.js';

interface TonePalette {
  stroke: string;
  fill: string;
  groupFill: string;
  groupStroke: string;
  text: string;
}

export const TONE_PALETTES: Record<SemanticTone, TonePalette> = {
  blue: {
    stroke: '#2563eb',
    fill: '#dbeafe',
    groupFill: '#eff6ff',
    groupStroke: '#60a5fa',
    text: '#1e3a8a',
  },
  purple: {
    stroke: '#7c3aed',
    fill: '#ede9fe',
    groupFill: '#f5f3ff',
    groupStroke: '#a78bfa',
    text: '#4c1d95',
  },
  green: {
    stroke: '#16a34a',
    fill: '#dcfce7',
    groupFill: '#f0fdf4',
    groupStroke: '#4ade80',
    text: '#14532d',
  },
  amber: {
    stroke: '#d97706',
    fill: '#fef3c7',
    groupFill: '#fffbeb',
    groupStroke: '#fbbf24',
    text: '#78350f',
  },
  rose: {
    stroke: '#e11d48',
    fill: '#ffe4e6',
    groupFill: '#fff1f2',
    groupStroke: '#fb7185',
    text: '#881337',
  },
  teal: {
    stroke: '#0d9488',
    fill: '#ccfbf1',
    groupFill: '#f0fdfa',
    groupStroke: '#2dd4bf',
    text: '#134e4a',
  },
  slate: {
    stroke: '#475569',
    fill: '#f1f5f9',
    groupFill: '#f8fafc',
    groupStroke: '#94a3b8',
    text: '#0f172a',
  },
  neutral: {
    stroke: '#334155',
    fill: '#ffffff',
    groupFill: '#f8fafc',
    groupStroke: '#cbd5e1',
    text: '#0f172a',
  },
};

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) || 1;
}

function resolveFontFamily(ff?: DiagramStyleOptions['fontFamily']): number {
  // Excalidraw fontFamily IDs: 1 = Virgil/Excalifont (hand), 2 = Helvetica/Sans, 3 = Cascadia/Mono
  if (ff === 'hand') return 1;
  if (ff === 'mono') return 3;
  return 2; // Clean sans by default so it looks sharp offline with zero CDN font fetch
}

function makeBaseElement(
  id: string,
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  style: DiagramStyleOptions | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10,
    angle: 0,
    strokeColor: '#334155',
    backgroundColor: 'transparent',
    fillStyle: style?.fillStyle ?? 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: style?.roughness ?? 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: { type: 3 },
    seed: hashSeed(id),
    version: 1,
    versionNonce: hashSeed(id + '_v1'),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
    ...extra,
  };
}

function inferNodeTone(node: PositionedNode): SemanticTone {
  if (node.spec.tone) return node.spec.tone;
  switch (node.spec.shape) {
    case 'database':
      return 'green';
    case 'queue':
    case 'note':
      return 'amber';
    case 'diamond':
      return 'purple';
    case 'ellipse':
      return 'teal';
    default:
      return 'blue';
  }
}

export interface CompileOptions {
  offsetX?: number;
  offsetY?: number;
  style?: DiagramStyleOptions;
  zoneId?: string;
}

/**
 * Compiles a positioned LayoutResult into 100% native, editable Excalidraw v2 elements
 * with complete containerId text bindings and startBinding/endBinding arrow attachments.
 */
export function compileLayoutToExcalidraw(
  layout: LayoutResult,
  options: CompileOptions = {},
): Record<string, unknown>[] {
  const ox = options.offsetX ?? 0;
  const oy = options.offsetY ?? 0;
  const style = options.style;
  const fontFamily = resolveFontFamily(style?.fontFamily);
  const zoneId = options.zoneId ?? `zone_${Date.now()}`;

  const elements: Record<string, unknown>[] = [];
  const shapeElByNodeId = new Map<string, Record<string, unknown>>();

  // 1. Groups (outer to inner, bottom z-order)
  for (const g of layout.groups as PositionedGroup[]) {
    const pal = TONE_PALETTES[g.spec.tone ?? 'slate'];
    const groupId = g.spec.id;
    const gx = g.x + ox;
    const gy = g.y + oy;

    const bgEl = makeBaseElement(groupId, 'rectangle', gx, gy, g.width, g.height, style, {
      strokeColor: pal.groupStroke,
      backgroundColor: pal.groupFill,
      strokeWidth: 1.5,
      strokeStyle: g.spec.borderStyle ?? 'dashed',
      opacity: 88,
      roundness: { type: 3 },
      customData: {
        semanticId: groupId,
        role: 'group',
        label: g.spec.label,
        parentGroup: g.spec.parentGroup ?? null,
        zoneId,
      },
    });
    elements.push(bgEl);

    const titleId = `${groupId}__title`;
    const titleEl = makeBaseElement(
      titleId,
      'text',
      gx + 14,
      gy + 10,
      Math.max(80, g.width - 28),
      22,
      style,
      {
        strokeColor: pal.text,
        backgroundColor: 'transparent',
        text: g.spec.label,
        originalText: g.spec.label,
        fontSize: 14,
        fontFamily,
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        containerId: null,
        autoResize: true,
        roundness: null,
        customData: {
          semanticId: titleId,
          role: 'group-title',
          parentGroupId: groupId,
          zoneId,
        },
      },
    );
    elements.push(titleEl);
  }

  // 2. Sequence lifelines (behind arrows, below actors)
  if (layout.lifelines) {
    for (const lf of layout.lifelines) {
      const lx = lf.x + ox;
      const ly = lf.topY + oy;
      const lh = Math.max(40, lf.bottomY - lf.topY);
      const lineId = `${lf.nodeId}__lifeline`;
      elements.push(
        makeBaseElement(lineId, 'line', lx, ly, 0, lh, style, {
          strokeColor: '#94a3b8',
          strokeWidth: 1.5,
          strokeStyle: 'dashed',
          points: [
            [0, 0],
            [0, Math.round(lh)],
          ],
          roundness: null,
          customData: {
            semanticId: lineId,
            role: 'lifeline',
            nodeId: lf.nodeId,
            zoneId,
          },
        }),
      );
    }
  }

  // 3. Nodes (middle z-order)
  for (const n of layout.nodes as PositionedNode[]) {
    const tone = inferNodeTone(n);
    const pal = TONE_PALETTES[tone];
    const shape = n.spec.shape ?? 'rounded';
    const nx = n.x + ox;
    const ny = n.y + oy;
    const nodeId = n.spec.id;

    if (shape === 'text') {
      const txtEl = makeBaseElement(nodeId, 'text', nx, ny, n.width, n.height, style, {
        strokeColor: pal.text,
        backgroundColor: 'transparent',
        text: n.displayText,
        originalText: n.displayText,
        fontSize: 20,
        fontFamily,
        textAlign: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.25,
        containerId: null,
        autoResize: true,
        roundness: null,
        customData: {
          semanticId: nodeId,
          role: 'node',
          shape,
          label: n.spec.label,
          sublabel: n.spec.sublabel ?? null,
          group: n.spec.group ?? null,
          zoneId,
        },
      });
      elements.push(txtEl);
      shapeElByNodeId.set(nodeId, txtEl);
      continue;
    }

    const exType =
      shape === 'diamond' ? 'diamond' : shape === 'ellipse' ? 'ellipse' : 'rectangle';
    const textId = `${nodeId}__label`;
    const dbGroupTag = shape === 'database' ? [`grp_${nodeId}`] : [];

    const roundness =
      shape === 'rect'
        ? null
        : shape === 'queue'
          ? { type: 3, value: 28 }
          : { type: 3 };

    const shapeEl = makeBaseElement(nodeId, exType, nx, ny, n.width, n.height, style, {
      strokeColor: pal.stroke,
      backgroundColor: pal.fill,
      strokeWidth: shape === 'note' ? 1.5 : 2,
      strokeStyle: shape === 'note' ? 'solid' : 'solid',
      roundness,
      groupIds: dbGroupTag,
      boundElements: [{ id: textId, type: 'text' }],
      customData: {
        semanticId: nodeId,
        role: 'node',
        shape,
        label: n.spec.label,
        sublabel: n.spec.sublabel ?? null,
        group: n.spec.group ?? null,
        tone,
        zoneId,
      },
    });
    elements.push(shapeEl);
    shapeElByNodeId.set(nodeId, shapeEl);

    // Visual top cap ellipse for `database` shape, grouped with body
    if (shape === 'database') {
      const capId = `${nodeId}__dbcap`;
      elements.push(
        makeBaseElement(capId, 'ellipse', nx, ny - 9, n.width, 18, style, {
          strokeColor: pal.stroke,
          backgroundColor: pal.fill,
          strokeWidth: 2,
          groupIds: dbGroupTag,
          roundness: null,
          customData: {
            semanticId: capId,
            role: 'decoration',
            ownerNodeId: nodeId,
            zoneId,
          },
        }),
      );
    }

    // Bound text inside shape (Excalidraw natively keeps containerId text centered on drag!)
    const textHeight = Math.max(22, n.height - 16);
    const textEl = makeBaseElement(
      textId,
      'text',
      nx + 8,
      ny + (n.height - textHeight) / 2,
      Math.max(24, n.width - 16),
      textHeight,
      style,
      {
        strokeColor: pal.text,
        backgroundColor: 'transparent',
        text: n.displayText,
        originalText: n.displayText,
        fontSize: n.spec.sublabel ? 14 : 15,
        fontFamily,
        textAlign: 'center',
        verticalAlign: 'middle',
        lineHeight: 1.28,
        containerId: nodeId,
        groupIds: dbGroupTag,
        autoResize: true,
        roundness: null,
        customData: {
          semanticId: textId,
          role: 'node-label',
          ownerNodeId: nodeId,
          zoneId,
        },
      },
    );
    elements.push(textEl);
  }

  // 4. Edges (top z-order) with native startBinding / endBinding + boundElements sync
  for (const e of layout.edges as RoutedEdge[]) {
    if (e.points.length < 2) continue;

    const p0 = e.points[0];
    const relPoints = e.points.map((p) => [
      Math.round((p.x - p0.x) * 10) / 10,
      Math.round((p.y - p0.y) * 10) / 10,
    ]);

    let minRx = 0;
    let maxRx = 0;
    let minRy = 0;
    let maxRy = 0;
    for (const [rx, ry] of relPoints) {
      minRx = Math.min(minRx, rx);
      maxRx = Math.max(maxRx, rx);
      minRy = Math.min(minRy, ry);
      maxRy = Math.max(maxRy, ry);
    }

    const fromEl = shapeElByNodeId.get(e.spec.from);
    const toEl = shapeElByNodeId.get(e.spec.to);
    const isSequence = Boolean(layout.lifelines);
    const edgeTone = e.spec.tone ? TONE_PALETTES[e.spec.tone].stroke : e.spec.emphasis === 'primary' ? '#2563eb' : '#475569';

    const labelId = e.spec.label ? `${e.id}__label` : null;
    const routing = e.spec.routing ?? 'orthogonal';
    const arrows = e.spec.arrows ?? 'end';

    const arrowEl = makeBaseElement(
      e.id,
      'arrow',
      p0.x + ox,
      p0.y + oy,
      Math.max(1, maxRx - minRx),
      Math.max(1, maxRy - minRy),
      style,
      {
        strokeColor: edgeTone,
        backgroundColor: 'transparent',
        strokeWidth: e.spec.emphasis === 'primary' ? 3 : 2,
        strokeStyle: e.spec.lineStyle ?? 'solid',
        roughness: style?.roughness ?? 1,
        points: relPoints,
        roundness: routing === 'curved' ? { type: 2 } : null,
        elbowed: routing === 'orthogonal' && relPoints.length > 2 ? false : false,
        startArrowhead: arrows === 'both' ? 'arrow' : null,
        endArrowhead: arrows === 'none' ? null : 'arrow',
        startBinding:
          !isSequence && fromEl
            ? { elementId: e.spec.from, focus: 0, gap: 4 }
            : null,
        endBinding:
          !isSequence && toEl
            ? { elementId: e.spec.to, focus: 0, gap: 4 }
            : null,
        boundElements: labelId ? [{ id: labelId, type: 'text' }] : [],
        customData: {
          semanticId: e.id,
          role: 'edge',
          from: e.spec.from,
          to: e.spec.to,
          label: e.spec.label ?? null,
          zoneId,
        },
      },
    );

    elements.push(arrowEl);

    // Register arrow in endpoint shapes' boundElements so Excalidraw updates arrow on drag
    if (!isSequence && fromEl && Array.isArray(fromEl.boundElements)) {
      (fromEl.boundElements as Array<{ id: string; type: string }>).push({
        id: e.id,
        type: 'arrow',
      });
    }
    if (!isSequence && toEl && Array.isArray(toEl.boundElements)) {
      (toEl.boundElements as Array<{ id: string; type: string }>).push({
        id: e.id,
        type: 'arrow',
      });
    }

    if (labelId && e.labelPos) {
      elements.push(
        makeBaseElement(
          labelId,
          'text',
          e.labelPos.x + ox,
          e.labelPos.y + oy,
          e.labelPos.width,
          e.labelPos.height,
          style,
          {
            strokeColor: '#334155',
            backgroundColor: 'transparent',
            text: e.labelPos.text,
            originalText: e.labelPos.text,
            fontSize: 13,
            fontFamily,
            textAlign: 'center',
            verticalAlign: 'middle',
            lineHeight: 1.25,
            containerId: e.id,
            autoResize: true,
            roundness: null,
            customData: {
              semanticId: labelId,
              role: 'edge-label',
              ownerEdgeId: e.id,
              zoneId,
            },
          },
        ),
      );
    }
  }

  return elements;
}
