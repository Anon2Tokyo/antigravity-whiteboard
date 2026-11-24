export type LayoutStrategy =
  | 'layered-tb'
  | 'layered-lr'
  | 'box'
  | 'stress'
  | 'mrtree'
  | 'sequence'
  | 'free';

export type NodeShape =
  | 'rounded'
  | 'rect'
  | 'diamond'
  | 'ellipse'
  | 'database'
  | 'queue'
  | 'note'
  | 'text';

export type SemanticTone =
  | 'blue'
  | 'purple'
  | 'green'
  | 'amber'
  | 'rose'
  | 'teal'
  | 'slate'
  | 'neutral';

export type EdgeLineStyle = 'solid' | 'dashed' | 'dotted';
export type EdgeArrows = 'end' | 'both' | 'none';
export type EdgeRouting = 'orthogonal' | 'curved' | 'straight';
export type PlacementMode = 'replace' | 'append-right' | 'append-below';

export interface DiagramGroupSpec {
  id: string;
  label: string;
  parentGroup?: string;
  tone?: SemanticTone;
  borderStyle?: 'dashed' | 'solid';
  layout?: 'layered-tb' | 'layered-lr' | 'box';
}

export interface DiagramNodeSpec {
  id: string;
  label: string;
  sublabel?: string;
  shape?: NodeShape;
  group?: string;
  tone?: SemanticTone;
  /** Optional rough coordinate hint for `free` layout */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DiagramEdgeSpec {
  id?: string;
  from: string;
  to: string;
  label?: string;
  lineStyle?: EdgeLineStyle;
  emphasis?: 'normal' | 'primary';
  arrows?: EdgeArrows;
  routing?: EdgeRouting;
  tone?: SemanticTone;
}

export interface DiagramStyleOptions {
  roughness?: 0 | 1 | 2;
  fillStyle?: 'solid' | 'hachure';
  fontFamily?: 'sans' | 'hand' | 'mono';
  spacing?: 'compact' | 'normal' | 'spacious';
}

export interface DiagramSpec {
  layout: LayoutStrategy;
  groups?: DiagramGroupSpec[];
  nodes: DiagramNodeSpec[];
  edges?: DiagramEdgeSpec[];
  style?: DiagramStyleOptions;
}

export interface RebindExternalEdgeSpec {
  edgeId: string;
  /** Which end of the external edge was inside the selected region */
  end: 'start' | 'end';
  /** New node semantic ID inside `replacement` to connect to */
  newNodeId: string;
  label?: string;
}

export interface BoardMeta {
  id: string;
  title: string;
  rev: number;
  elementCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface ExcalidrawSceneFile {
  type: 'excalidraw';
  version: 2;
  source: 'antigravity-whiteboard';
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export interface StoredBoard {
  meta: BoardMeta;
  scene: ExcalidrawSceneFile;
}

export interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SelectedElementSummary {
  id: string;
  semanticId?: string;
  type: string;
  label?: string;
  group?: string;
  bounds: [number, number, number, number];
  from?: string;
  to?: string;
}

export interface ExternalBoundaryEdge {
  edgeId: string;
  direction: 'incoming' | 'outgoing';
  selectedNodeId: string;
  externalNode: {
    id: string;
    label?: string;
    bounds: [number, number, number, number];
  };
  label?: string;
}

export interface NearbyObstacle {
  id: string;
  label?: string;
  side: 'left' | 'right' | 'top' | 'bottom';
  bounds: [number, number, number, number];
}

export interface SelectionContextPayload {
  boardId: string;
  boardTitle: string;
  selectionBox: SelectionBox;
  selectedElements: SelectedElementSummary[];
  externalBoundaryEdges: ExternalBoundaryEdge[];
  nearbyObstacles: NearbyObstacle[];
  snapshotPath?: string;
}
