import type {
  ExternalBoundaryEdge,
  NearbyObstacle,
  SelectedElementSummary,
  SelectionBox,
  SelectionContextPayload,
} from '../shared/dsl';

type ExEl = Record<string, unknown>;

function getBounds(el: ExEl): [number, number, number, number] {
  const x = Number(el.x ?? 0);
  const y = Number(el.y ?? 0);
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
    return [
      Math.round(minX),
      Math.round(minY),
      Math.round(Math.max(1, maxX - minX)),
      Math.round(Math.max(1, maxY - minY)),
    ];
  }
  return [
    Math.round(x),
    Math.round(y),
    Math.round(Math.abs(Number(el.width ?? 0))),
    Math.round(Math.abs(Number(el.height ?? 0))),
  ];
}

function getLabel(el: ExEl, byId: Map<string, ExEl>): string | undefined {
  if (el.type === 'text' && typeof el.text === 'string') return el.text;
  const custom = el.customData as Record<string, unknown> | undefined;
  if (typeof custom?.label === 'string' && custom.label) return custom.label;
  const bound = Array.isArray(el.boundElements)
    ? (el.boundElements as Array<{ id: string; type: string }>)
    : [];
  for (const b of bound) {
    if (b.type === 'text') {
      const txt = byId.get(b.id);
      if (txt && typeof txt.text === 'string') return txt.text;
    }
  }
  return undefined;
}

export function extractSelectionContext(
  boardId: string,
  boardTitle: string,
  allElements: readonly ExEl[],
  selectedIds: Set<string>,
  snapshotPath?: string,
): SelectionContextPayload | null {
  const active = allElements.filter((e) => !e.isDeleted);
  if (selectedIds.size === 0) return null;

  const byId = new Map<string, ExEl>();
  for (const el of active) byId.set(String(el.id), el);

  // If user selected only a bound text label, promote its container shape into selection
  const normalizedIds = new Set<string>(selectedIds);
  for (const id of selectedIds) {
    const el = byId.get(id);
    if (el && typeof el.containerId === 'string' && byId.has(el.containerId)) {
      normalizedIds.add(el.containerId);
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const selectedElements: SelectedElementSummary[] = [];

  for (const el of active) {
    const id = String(el.id);
    if (!normalizedIds.has(id)) continue;

    const custom = (el.customData ?? {}) as Record<string, unknown>;
    const role = custom.role as string | undefined;

    // Skip child labels & decorative caps when their parent is already captured
    if (
      (typeof el.containerId === 'string' && normalizedIds.has(el.containerId)) ||
      role === 'decoration' ||
      role === 'group-title'
    ) {
      continue;
    }

    const bounds = getBounds(el);
    minX = Math.min(minX, bounds[0]);
    minY = Math.min(minY, bounds[1]);
    maxX = Math.max(maxX, bounds[0] + bounds[2]);
    maxY = Math.max(maxY, bounds[1] + bounds[3]);

    const startB = el.startBinding as { elementId?: string } | null;
    const endB = el.endBinding as { elementId?: string } | null;

    selectedElements.push({
      id,
      semanticId: typeof custom.semanticId === 'string' ? custom.semanticId : undefined,
      type: typeof custom.shape === 'string' ? custom.shape : String(el.type),
      label: getLabel(el, byId),
      group: typeof custom.group === 'string' ? custom.group : undefined,
      bounds,
      from: el.type === 'arrow' ? startB?.elementId : undefined,
      to: el.type === 'arrow' ? endB?.elementId : undefined,
    });
  }

  if (selectedElements.length === 0 || !Number.isFinite(minX)) return null;

  const selectionBox: SelectionBox = {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };

  // Discover external boundary edges (one endpoint inside selection, one outside)
  const externalBoundaryEdges: ExternalBoundaryEdge[] = [];
  for (const el of active) {
    if (el.type !== 'arrow') continue;
    const edgeId = String(el.id);
    const startId = (el.startBinding as { elementId?: string } | null)?.elementId;
    const endId = (el.endBinding as { elementId?: string } | null)?.elementId;
    if (!startId || !endId) continue;

    const startIn = normalizedIds.has(startId);
    const endIn = normalizedIds.has(endId);

    if (startIn !== endIn) {
      const externalId = startIn ? endId : startId;
      const selectedNodeId = startIn ? startId : endId;
      const extEl = byId.get(externalId);
      if (!extEl) continue;

      externalBoundaryEdges.push({
        edgeId,
        direction: startIn ? 'outgoing' : 'incoming',
        selectedNodeId,
        externalNode: {
          id: externalId,
          label: getLabel(extEl, byId),
          bounds: getBounds(extEl),
        },
        label: getLabel(el, byId),
      });
    }
  }

  // Discover nearby unselected shapes (obstacles within 260px of selectionBox)
  const nearbyObstacles: NearbyObstacle[] = [];
  const scx = selectionBox.x + selectionBox.width / 2;
  const scy = selectionBox.y + selectionBox.height / 2;
  const margin = 260;

  for (const el of active) {
    const id = String(el.id);
    if (normalizedIds.has(id)) continue;
    if (el.type === 'arrow' || el.type === 'line' || el.containerId) continue;
    const custom = (el.customData ?? {}) as Record<string, unknown>;
    if (custom.role === 'group' || custom.role === 'group-title' || custom.role === 'decoration') continue;

    const b = getBounds(el);
    const nearX = b[0] < selectionBox.x + selectionBox.width + margin && b[0] + b[2] > selectionBox.x - margin;
    const nearY = b[1] < selectionBox.y + selectionBox.height + margin && b[1] + b[3] > selectionBox.y - margin;
    if (!nearX || !nearY) continue;

    const cx = b[0] + b[2] / 2;
    const cy = b[1] + b[3] / 2;
    const dx = cx - scx;
    const dy = cy - scy;
    const side: NearbyObstacle['side'] =
      Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';

    nearbyObstacles.push({
      id,
      label: getLabel(el, byId),
      side,
      bounds: b,
    });
    if (nearbyObstacles.length >= 12) break;
  }

  return {
    boardId,
    boardTitle,
    selectionBox,
    selectedElements,
    externalBoundaryEdges,
    nearbyObstacles,
    snapshotPath,
  };
}

export function formatSelectionContextForAI(ctx: SelectionContextPayload): string {
  const lines: string[] = [
    `Whiteboard Selection Context`,
    `- Board: "${ctx.boardTitle}" (boardId: \`${ctx.boardId}\`)`,
    `- Selection Bounds: x=${ctx.selectionBox.x}, y=${ctx.selectionBox.y}, w=${ctx.selectionBox.width}, h=${ctx.selectionBox.height}`,
  ];

  if (ctx.snapshotPath) {
    lines.push(`- Visual Snapshot PNG (inspect via read_file if visual/layout quality matters): \`${ctx.snapshotPath}\``);
  }

  lines.push(
    `- Hint: Use \`replace_region\` with \`targetIds\` below to redesign only this region without moving external elements, or \`patch_elements\` for minor tweaks. Rebind \`externalBoundaryEdges\` if replacing connected nodes.`,
  );
  lines.push('```json');
  lines.push(
    JSON.stringify(
      {
        boardId: ctx.boardId,
        targetIds: ctx.selectedElements.map((e) => e.id),
        selectedElements: ctx.selectedElements,
        externalBoundaryEdges: ctx.externalBoundaryEdges,
        nearbyObstacles: ctx.nearbyObstacles,
      },
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}
