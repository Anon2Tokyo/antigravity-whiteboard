import type {
  DiagramEdgeSpec,
  DiagramNodeSpec,
  DiagramSpec,
  RebindExternalEdgeSpec,
  SemanticTone,
} from '../shared/dsl.js';
import {
  computeDiagramLayout,
  routeSimpleOrthogonal,
  type RectBox,
} from './layout-engine.js';
import { compileLayoutToExcalidraw, TONE_PALETTES } from './excalidraw-compiler.js';

type ExEl = Record<string, unknown>;

export interface SceneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function getElRect(el: ExEl): RectBox | null {
  if (el.isDeleted) return null;
  const id = String(el.id ?? '');
  const x = Number(el.x ?? 0);
  const y = Number(el.y ?? 0);
  const width = Math.abs(Number(el.width ?? 0));
  const height = Math.abs(Number(el.height ?? 0));

  if (el.type === 'arrow' || el.type === 'line') {
    const pts = Array.isArray(el.points) ? (el.points as number[][]) : [[0, 0]];
    let minX = x;
    let minY = y;
    let maxX = x;
    let maxY = y;
    for (const [px, py] of pts) {
      minX = Math.min(minX, x + px);
      minY = Math.min(minY, y + py);
      maxX = Math.max(maxX, x + px);
      maxY = Math.max(maxY, y + py);
    }
    return { id, x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  return { id, x, y, width, height };
}

export function computeSceneBounds(elements: ExEl[]): SceneBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    const r = getElRect(el);
    if (!r) continue;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }

  if (!Number.isFinite(minX)) return null;
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

function getBoundTextFor(el: ExEl, allById: Map<string, ExEl>): string | undefined {
  if (el.type === 'text' && typeof el.text === 'string') return el.text;
  const custom = el.customData as Record<string, unknown> | undefined;
  if (typeof custom?.label === 'string' && custom.label) return custom.label;
  const bound = Array.isArray(el.boundElements) ? (el.boundElements as Array<{ id: string; type: string }>) : [];
  for (const b of bound) {
    if (b.type === 'text') {
      const t = allById.get(b.id);
      if (t && typeof t.text === 'string') return t.text;
    }
  }
  return undefined;
}

/**
 * Compact spatial semantic summary of a board for the AI (avoids dumping massive raw Excalidraw JSON).
 */
export function summarizeBoard(elements: ExEl[]): {
  totalElements: number;
  bounds: SceneBounds | null;
  groups: Array<{ id: string; label: string; bounds: [number, number, number, number] }>;
  nodes: Array<{ id: string; type: string; label?: string; group?: string; bounds: [number, number, number, number] }>;
  edges: Array<{ id: string; from?: string; to?: string; label?: string }>;
} {
  const active = elements.filter((e) => !e.isDeleted);
  const byId = new Map<string, ExEl>();
  for (const e of active) byId.set(String(e.id), e);

  const groups: Array<{ id: string; label: string; bounds: [number, number, number, number] }> = [];
  const nodes: Array<{ id: string; type: string; label?: string; group?: string; bounds: [number, number, number, number] }> = [];
  const edges: Array<{ id: string; from?: string; to?: string; label?: string }> = [];

  for (const el of active) {
    const id = String(el.id);
    const custom = (el.customData ?? {}) as Record<string, unknown>;
    const role = custom.role as string | undefined;

    // Skip bound text labels, decorations, lifelines, group titles
    if (
      el.containerId ||
      role === 'node-label' ||
      role === 'edge-label' ||
      role === 'group-title' ||
      role === 'decoration' ||
      role === 'lifeline'
    ) {
      continue;
    }

    const rect = getElRect(el);
    if (!rect) continue;
    const bTuple: [number, number, number, number] = [
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
    ];

    if (role === 'group') {
      groups.push({
        id,
        label: String(custom.label ?? id),
        bounds: bTuple,
      });
      continue;
    }

    if (el.type === 'arrow') {
      const startB = el.startBinding as { elementId?: string } | null;
      const endB = el.endBinding as { elementId?: string } | null;
      edges.push({
        id,
        from: startB?.elementId ?? (custom.from as string | undefined),
        to: endB?.elementId ?? (custom.to as string | undefined),
        label: getBoundTextFor(el, byId),
      });
      continue;
    }

    if (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse' || el.type === 'text') {
      nodes.push({
        id,
        type: String(custom.shape ?? el.type),
        label: getBoundTextFor(el, byId),
        group: (custom.group as string | undefined) ?? undefined,
        bounds: bTuple,
      });
    }
  }

  return {
    totalElements: active.length,
    bounds: computeSceneBounds(active),
    groups,
    nodes,
    edges,
  };
}

function rectsOverlap(a: RectBox, b: RectBox, margin = 16): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

/**
 * Surgical region replacement:
 * 1. Locks all non-targeted elements.
 * 2. Lays out the replacement subgraph inside/anchored to the old selectionBox.
 * 3. Protects external elements from overlap (shifts replacement into safe gap if needed).
 * 4. Re-routes and re-binds external boundary edges to newly created entry/exit nodes.
 */
export async function replaceRegion(
  existingElements: ExEl[],
  targetIds: string[],
  replacement: DiagramSpec,
  rebindExternalEdges: RebindExternalEdgeSpec[] = [],
): Promise<{
  elements: ExEl[];
  replacedCount: number;
  addedCount: number;
  reboundEdges: number;
  regionBounds: SceneBounds;
}> {
  const active = existingElements.filter((e) => !e.isDeleted);
  const removeSet = new Set<string>(targetIds);

  // Expand removeSet to include bound labels, database caps, group titles, and internal edges
  for (const el of active) {
    const id = String(el.id);
    const custom = (el.customData ?? {}) as Record<string, unknown>;
    if (
      (typeof el.containerId === 'string' && removeSet.has(el.containerId)) ||
      (typeof custom.ownerNodeId === 'string' && removeSet.has(custom.ownerNodeId)) ||
      (typeof custom.ownerEdgeId === 'string' && removeSet.has(custom.ownerEdgeId)) ||
      (typeof custom.parentGroupId === 'string' && removeSet.has(custom.parentGroupId))
    ) {
      removeSet.add(id);
    }
  }

  // Also remove arrows whose BOTH ends are in removeSet (internal arrows),
  // while KEEPING external boundary edges (only one end inside removeSet) so we can rebind them!
  const rebindMap = new Map<string, RebindExternalEdgeSpec>();
  for (const r of rebindExternalEdges) rebindMap.set(r.edgeId, r);

  for (const el of active) {
    if (el.type !== 'arrow') continue;
    const id = String(el.id);
    const startId = (el.startBinding as { elementId?: string } | null)?.elementId;
    const endId = (el.endBinding as { elementId?: string } | null)?.elementId;
    const startIn = startId ? removeSet.has(startId) : false;
    const endIn = endId ? removeSet.has(endId) : false;

    if (startIn && endIn) {
      removeSet.add(id);
    } else if ((startIn || endIn) && !rebindMap.has(id) && removeSet.has(id)) {
      // Explicitly targeted arrow without rebind -> remove
      removeSet.add(id);
    } else if ((startIn || endIn) && rebindMap.has(id)) {
      // Keep external boundary edge so we can rebind it below
      removeSet.delete(id);
    }
  }

  // Re-run bound-text expansion for any newly added internal arrows
  for (const el of active) {
    if (typeof el.containerId === 'string' && removeSet.has(el.containerId)) {
      removeSet.add(String(el.id));
    }
  }

  const removedEls = active.filter((e) => removeSet.has(String(e.id)));
  const lockedEls = active
    .filter((e) => !removeSet.has(String(e.id)))
    .map((e) => structuredClone(e));

  // Clean dangling boundElements references on locked shapes
  for (const el of lockedEls) {
    if (Array.isArray(el.boundElements)) {
      el.boundElements = (el.boundElements as Array<{ id: string; type: string }>).filter(
        (b) => !removeSet.has(b.id),
      );
    }
  }

  const oldBounds = computeSceneBounds(removedEls) ?? { x: 100, y: 100, width: 240, height: 140 };
  const layout = await computeDiagramLayout(replacement);

  // Center replacement on the old selection box
  let offsetX = oldBounds.x + (oldBounds.width - layout.bounds.width) / 2;
  let offsetY = oldBounds.y + (oldBounds.height - layout.bounds.height) / 2;

  // Collision check against locked external non-group nodes
  const externalNodeBoxes: RectBox[] = [];
  for (const el of lockedEls) {
    const custom = (el.customData ?? {}) as Record<string, unknown>;
    if (
      custom.role === 'group' ||
      el.type === 'arrow' ||
      el.type === 'line' ||
      el.containerId
    ) {
      continue;
    }
    const r = getElRect(el);
    if (r) externalNodeBoxes.push(r);
  }

  // Find the closest position to oldBounds center that has ZERO overlap with all locked external nodes
  const margin = 24;
  const collidesAny = (x: number, y: number): RectBox[] => {
    const box: RectBox = { id: '__replacement__', x, y, width: layout.bounds.width, height: layout.bounds.height };
    return externalNodeBoxes.filter((ext) => rectsOverlap(box, ext, margin));
  };

  const baseX = offsetX;
  const baseY = offsetY;
  const initialHits = collidesAny(baseX, baseY);
  if (initialHits.length > 0) {
    // Compute combined bounding box of blockers and test clean cardinal escapes + progressive rings
    let hitMinX = Infinity;
    let hitMinY = Infinity;
    let hitMaxX = -Infinity;
    let hitMaxY = -Infinity;
    for (const h of initialHits) {
      hitMinX = Math.min(hitMinX, h.x);
      hitMinY = Math.min(hitMinY, h.y);
      hitMaxX = Math.max(hitMaxX, h.x + h.width);
      hitMaxY = Math.max(hitMaxY, h.y + h.height);
    }

    const candidates: Array<{ x: number; y: number }> = [
      { x: baseX, y: hitMaxY + margin + 4 }, // below blockers
      { x: baseX, y: hitMinY - layout.bounds.height - margin - 4 }, // above blockers
      { x: hitMaxX + margin + 4, y: baseY }, // right of blockers
      { x: hitMinX - layout.bounds.width - margin - 4, y: baseY }, // left of blockers
    ];

    // Also include global scene edges as guaranteed collision-free fallbacks
    const lockedBounds = computeSceneBounds(lockedEls);
    if (lockedBounds) {
      candidates.push(
        { x: baseX, y: lockedBounds.y + lockedBounds.height + margin + 20 },
        { x: lockedBounds.x + lockedBounds.width + margin + 20, y: baseY },
        { x: baseX, y: lockedBounds.y - layout.bounds.height - margin - 20 },
      );
    }

    let best: { x: number; y: number; dist: number } | null = null;
    for (const c of candidates) {
      if (collidesAny(c.x, c.y).length === 0) {
        const dist = Math.hypot(c.x - baseX, c.y - baseY);
        if (!best || dist < best.dist) {
          best = { x: c.x, y: c.y, dist };
        }
      }
    }

    if (best) {
      offsetX = best.x;
      offsetY = best.y;
    }
  }

  const newElements = compileLayoutToExcalidraw(layout, {
    offsetX,
    offsetY,
    style: replacement.style,
    zoneId: `region_${Date.now()}`,
  });

  const combined = [...lockedEls, ...newElements];
  const byId = new Map<string, ExEl>();
  for (const el of combined) byId.set(String(el.id), el);

  // Rebind external boundary edges to newly created entry/exit nodes
  let reboundEdges = 0;
  for (const rb of rebindExternalEdges) {
    const edgeEl = byId.get(rb.edgeId);
    const targetNode = byId.get(rb.newNodeId);
    if (!edgeEl || !targetNode || edgeEl.type !== 'arrow') continue;

    if (rb.end === 'start') {
      edgeEl.startBinding = { elementId: rb.newNodeId, focus: 0, gap: 4 };
    } else {
      edgeEl.endBinding = { elementId: rb.newNodeId, focus: 0, gap: 4 };
    }

    const startId = (edgeEl.startBinding as { elementId?: string } | null)?.elementId;
    const endId = (edgeEl.endBinding as { elementId?: string } | null)?.elementId;
    const startEl = startId ? byId.get(startId) : undefined;
    const endEl = endId ? byId.get(endId) : undefined;

    if (startEl && endEl) {
      const fromRect = getElRect(startEl);
      const toRect = getElRect(endEl);
      if (fromRect && toRect) {
        const pts = routeSimpleOrthogonal(fromRect, toRect, reboundEdges);
        const p0 = pts[0];
        const rel = pts.map((p) => [Math.round(p.x - p0.x), Math.round(p.y - p0.y)]);
        edgeEl.x = Math.round(p0.x);
        edgeEl.y = Math.round(p0.y);
        edgeEl.points = rel;
        edgeEl.version = Number(edgeEl.version ?? 1) + 1;
        edgeEl.updated = Date.now();
      }
    }

    if (Array.isArray(targetNode.boundElements)) {
      const list = targetNode.boundElements as Array<{ id: string; type: string }>;
      if (!list.some((b) => b.id === rb.edgeId)) {
        list.push({ id: rb.edgeId, type: 'arrow' });
      }
    }

    // Update optional label
    if (rb.label) {
      const bound = Array.isArray(edgeEl.boundElements)
        ? (edgeEl.boundElements as Array<{ id: string; type: string }>)
        : [];
      const txtRef = bound.find((b) => b.type === 'text');
      if (txtRef) {
        const txtEl = byId.get(txtRef.id);
        if (txtEl) {
          txtEl.text = rb.label;
          txtEl.originalText = rb.label;
        }
      }
    }

    reboundEdges++;
  }

  return {
    elements: combined,
    replacedCount: removedEls.length,
    addedCount: newElements.length,
    reboundEdges,
    regionBounds: {
      x: Math.round(offsetX),
      y: Math.round(offsetY),
      width: Math.round(layout.bounds.width),
      height: Math.round(layout.bounds.height),
    },
  };
}

export interface PatchUpdateSpec {
  id: string;
  label?: string;
  tone?: SemanticTone;
  dx?: number;
  dy?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
}

export interface PatchElementsInput {
  addNodes?: DiagramNodeSpec[];
  addEdges?: DiagramEdgeSpec[];
  update?: PatchUpdateSpec[];
  deleteIds?: string[];
}

/**
 * Fine-grained incremental patching without disturbing existing manual layout.
 */
export async function patchElements(
  existingElements: ExEl[],
  patch: PatchElementsInput,
): Promise<{
  elements: ExEl[];
  updatedCount: number;
  addedCount: number;
  deletedCount: number;
}> {
  const active = existingElements.filter((e) => !e.isDeleted).map((e) => structuredClone(e));
  const deleteSet = new Set<string>(patch.deleteIds ?? []);

  if (deleteSet.size > 0) {
    for (const el of active) {
      const custom = (el.customData ?? {}) as Record<string, unknown>;
      if (
        (typeof el.containerId === 'string' && deleteSet.has(el.containerId)) ||
        (typeof custom.ownerNodeId === 'string' && deleteSet.has(custom.ownerNodeId)) ||
        (typeof custom.parentGroupId === 'string' && deleteSet.has(custom.parentGroupId))
      ) {
        deleteSet.add(String(el.id));
      }
    }
  }

  const kept = active.filter((e) => !deleteSet.has(String(e.id)));
  const byId = new Map<string, ExEl>();
  for (const e of kept) {
    if (Array.isArray(e.boundElements)) {
      e.boundElements = (e.boundElements as Array<{ id: string; type: string }>).filter(
        (b) => !deleteSet.has(b.id),
      );
    }
    byId.set(String(e.id), e);
  }

  let updatedCount = 0;
  for (const upd of patch.update ?? []) {
    const el = byId.get(upd.id);
    if (!el) continue;

    if (upd.tone && TONE_PALETTES[upd.tone]) {
      const pal = TONE_PALETTES[upd.tone];
      if (el.type === 'arrow' || el.type === 'line') {
        el.strokeColor = pal.stroke;
      } else if ((el.customData as Record<string, unknown> | undefined)?.role === 'group') {
        el.strokeColor = pal.groupStroke;
        el.backgroundColor = pal.groupFill;
      } else {
        el.strokeColor = pal.stroke;
        el.backgroundColor = pal.fill;
      }
    }
    if (upd.strokeStyle) {
      el.strokeStyle = upd.strokeStyle;
    }
    if (typeof upd.dx === 'number' || typeof upd.dy === 'number') {
      const dx = upd.dx ?? 0;
      const dy = upd.dy ?? 0;
      el.x = Number(el.x ?? 0) + dx;
      el.y = Number(el.y ?? 0) + dy;
      // Move bound text along with shape
      for (const child of kept) {
        if (child.containerId === upd.id) {
          child.x = Number(child.x ?? 0) + dx;
          child.y = Number(child.y ?? 0) + dy;
        }
      }
    }
    if (typeof upd.label === 'string') {
      if (el.type === 'text') {
        el.text = upd.label;
        el.originalText = upd.label;
      } else {
        const bound = Array.isArray(el.boundElements)
          ? (el.boundElements as Array<{ id: string; type: string }>)
          : [];
        const txtRef = bound.find((b) => b.type === 'text');
        if (txtRef) {
          const txtEl = byId.get(txtRef.id);
          if (txtEl) {
            txtEl.text = upd.label;
            txtEl.originalText = upd.label;
          }
        }
      }
      if (el.customData && typeof el.customData === 'object') {
        (el.customData as Record<string, unknown>).label = upd.label;
      }
    }
    el.version = Number(el.version ?? 1) + 1;
    el.updated = Date.now();
    updatedCount++;
  }

  let addedCount = 0;
  if (patch.addNodes && patch.addNodes.length > 0) {
    const existingBounds = computeSceneBounds(kept);
    const addLayout = await computeDiagramLayout({
      layout: 'free',
      nodes: patch.addNodes,
      edges: [],
    });
    const hasExplicitCoords = patch.addNodes.some((n) => typeof n.x === 'number' || typeof n.y === 'number');
    const ox = hasExplicitCoords ? 0 : existingBounds ? existingBounds.x + existingBounds.width + 80 : 80;
    const oy = hasExplicitCoords ? 0 : existingBounds ? existingBounds.y : 80;
    const compiled = compileLayoutToExcalidraw(addLayout, { offsetX: ox, offsetY: oy });
    for (const el of compiled) {
      kept.push(el);
      byId.set(String(el.id), el);
    }
    addedCount += compiled.length;
  }

  if (patch.addEdges && patch.addEdges.length > 0) {
    patch.addEdges.forEach((es, idx) => {
      const fromEl = byId.get(es.from);
      const toEl = byId.get(es.to);
      if (!fromEl || !toEl) return;
      const fr = getElRect(fromEl);
      const tr = getElRect(toEl);
      if (!fr || !tr) return;
      const pts = routeSimpleOrthogonal(fr, tr, idx);
      const edgeId = es.id || `edge_patch_${Date.now()}_${idx}`;
      const compiled = compileLayoutToExcalidraw({
        groups: [],
        nodes: [],
        edges: [
          {
            id: edgeId,
            spec: es,
            points: pts,
            labelPos: es.label
              ? {
                  x: (pts[0].x + pts[pts.length - 1].x) / 2 - 40,
                  y: (pts[0].y + pts[pts.length - 1].y) / 2 - 12,
                  width: 80,
                  height: 22,
                  text: es.label,
                }
              : undefined,
          },
        ],
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      });
      for (const el of compiled) {
        if (el.type === 'arrow') {
          el.startBinding = { elementId: es.from, focus: 0, gap: 4 };
          el.endBinding = { elementId: es.to, focus: 0, gap: 4 };
        }
        kept.push(el);
      }
      if (Array.isArray(fromEl.boundElements)) {
        (fromEl.boundElements as Array<{ id: string; type: string }>).push({ id: edgeId, type: 'arrow' });
      }
      if (Array.isArray(toEl.boundElements)) {
        (toEl.boundElements as Array<{ id: string; type: string }>).push({ id: edgeId, type: 'arrow' });
      }
      addedCount += compiled.length;
    });
  }

  return {
    elements: kept,
    updatedCount,
    addedCount,
    deletedCount: deleteSet.size,
  };
}
