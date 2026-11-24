import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { DiagramSpec, PlacementMode } from '../shared/dsl.js';
import { compileLayoutToExcalidraw } from './excalidraw-compiler.js';
import { computeDiagramLayout } from './layout-engine.js';
import { parseMermaidToDiagramSpec } from './mermaid-importer.js';
import {
  computeSceneBounds,
  patchElements,
  replaceRegion,
  summarizeBoard,
} from './region-editor.js';
import { BoardStorage } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://antigravity-whiteboard/app.html';
const storage = new BoardStorage();

const server = new McpServer({
  name: 'antigravity-whiteboard',
  version: '0.1.0',
});

function ok(data: Record<string, unknown>, summary = 'ok') {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: data,
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: message },
  };
}

// Zod schemas for declarative diagramming
const ToneSchema = z.enum(['blue', 'purple', 'green', 'amber', 'rose', 'teal', 'slate', 'neutral']);
const ShapeSchema = z.enum(['rounded', 'rect', 'diamond', 'ellipse', 'database', 'queue', 'note', 'text']);
const LayoutSchema = z.enum([
  'layered-tb',
  'layered-lr',
  'box',
  'stress',
  'mrtree',
  'sequence',
  'free',
]);

const GroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  parentGroup: z.string().optional(),
  tone: ToneSchema.optional(),
  borderStyle: z.enum(['dashed', 'solid']).optional(),
  layout: z.enum(['layered-tb', 'layered-lr', 'box']).optional(),
});

const NodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  sublabel: z.string().optional(),
  shape: ShapeSchema.optional(),
  group: z.string().optional(),
  tone: ToneSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const EdgeSchema = z.object({
  id: z.string().optional(),
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  lineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  emphasis: z.enum(['normal', 'primary']).optional(),
  arrows: z.enum(['end', 'both', 'none']).optional(),
  routing: z.enum(['orthogonal', 'curved', 'straight']).optional(),
  tone: ToneSchema.optional(),
});

const StyleSchema = z.object({
  roughness: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  fillStyle: z.enum(['solid', 'hachure']).optional(),
  fontFamily: z.enum(['sans', 'hand', 'mono']).optional(),
  spacing: z.enum(['compact', 'normal', 'spacious']).optional(),
});

// 1. Register single-file Excalidraw MCP App HTML resource
registerAppResource(
  server,
  'Whiteboard Canvas',
  APP_URI,
  {
    description: 'Interactive Excalidraw whiteboard with multi-layout ELK rendering and box-selection AI editing.',
    mimeType: RESOURCE_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  },
  async () => {
    const htmlPath =
      process.env.ANTIGRAVITY_WHITEBOARD_HTML || path.join(__dirname, 'index.html');
    const html = await fs.readFile(htmlPath, 'utf8');
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: { ui: { prefersBorder: false } },
        },
      ],
    };
  },
);

// 2. Main Sidebar Entrypoint Tool (appears once in right "+" menu and once in left global sidebar)
registerAppTool(
  server,
  'open_whiteboard',
  {
    title: 'Whiteboard',
    description:
      'Open the Excalidraw architecture whiteboard in the sidebar or switch to a specific board.',
    inputSchema: {
      boardId: z.string().optional().describe('Optional board ID to open.'),
      title: z.string().optional().describe('Optional title if creating a new board.'),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'global', title: 'Whiteboard' },
          { type: 'aux_pane', title: 'Whiteboard' },
        ],
      },
    },
  },
  async ({ boardId, title }) => {
    try {
      const board = await storage.loadOrCreateBoard(boardId, title);
      const boards = await storage.listBoards();
      return ok(
        {
          boardId: board.meta.id,
          meta: board.meta,
          boards,
        },
        `Opened Whiteboard "${board.meta.title}" (${board.meta.elementCount} elements, rev ${board.meta.rev}).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

// 3. AI-Facing Diagramming & Inspection Tools
server.registerTool(
  'list_boards',
  {
    title: 'List Whiteboard Boards',
    description: 'List all saved whiteboard diagrams with ID, title, revision, and element counts.',
    inputSchema: {},
  },
  async () => {
    try {
      const boards = await storage.listBoards();
      return ok({ boards }, `Found ${boards.length} board(s).`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'get_board_summary',
  {
    title: 'Get Board Spatial Summary',
    description:
      'Read a compact semantic & spatial summary (groups, node IDs, labels, bounds, edges) of a whiteboard without loading raw Excalidraw JSON.',
    inputSchema: {
      boardId: z.string().optional().describe('Board ID. Defaults to the currently active board.'),
    },
  },
  async ({ boardId }) => {
    try {
      const board = await storage.loadOrCreateBoard(boardId);
      const summary = summarizeBoard(board.scene.elements);
      return ok(
        {
          boardId: board.meta.id,
          title: board.meta.title,
          rev: board.meta.rev,
          ...summary,
        },
        `Board "${board.meta.title}" (${board.meta.id}): ${summary.nodes.length} nodes, ${summary.groups.length} groups, ${summary.edges.length} edges.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

async function applyDiagramSpec(
  spec: DiagramSpec,
  options: { boardId?: string; title?: string; placement?: PlacementMode },
) {
  const board = await storage.loadOrCreateBoard(options.boardId, options.title);
  const placement: PlacementMode = options.placement ?? 'replace';

  const layout = await computeDiagramLayout(spec);
  const existingActive = board.scene.elements.filter((e) => !e.isDeleted);
  const existingBounds = computeSceneBounds(existingActive);

  let offsetX = 60;
  let offsetY = 60;
  if (placement === 'append-right' && existingBounds) {
    offsetX = existingBounds.x + existingBounds.width + 120;
    offsetY = existingBounds.y;
  } else if (placement === 'append-below' && existingBounds) {
    offsetX = existingBounds.x;
    offsetY = existingBounds.y + existingBounds.height + 120;
  }

  const compiled = compileLayoutToExcalidraw(layout, {
    offsetX,
    offsetY,
    style: spec.style,
  });

  const nextElements =
    placement === 'replace' ? compiled : [...existingActive, ...compiled];

  const { board: saved } = await storage.saveScene(board.meta.id, nextElements, {
    title: options.title,
    recordUndo: true,
  });

  return {
    boardId: saved.meta.id,
    title: saved.meta.title,
    rev: saved.meta.rev,
    layout: spec.layout,
    placement,
    nodeCount: layout.nodes.length,
    groupCount: layout.groups.length,
    edgeCount: layout.edges.length,
    bounds: {
      x: Math.round(offsetX),
      y: Math.round(offsetY),
      width: Math.round(layout.bounds.width),
      height: Math.round(layout.bounds.height),
    },
  };
}

registerAppTool(
  server,
  'draw_diagram',
  {
    title: 'Draw Diagram on Whiteboard',
    description:
      'Draw a non-overlapping, native editable Excalidraw diagram using ELK.js multi-layout engine. Choose layout by intent: layered-tb (architecture), layered-lr (data flow/pipeline), box (nested module blueprint), stress (dependency mesh), mrtree (tree), sequence (interaction timeline), or free (custom zones with collision protection).',
    inputSchema: {
      boardId: z.string().optional().describe('Target board ID (defaults to active board or creates one).'),
      title: z.string().optional().describe('Board title.'),
      layout: LayoutSchema.describe('Layout engine strategy.'),
      placement: z
        .enum(['replace', 'append-right', 'append-below'])
        .optional()
        .describe('Whether to replace board content or append next to existing diagrams.'),
      groups: z.array(GroupSchema).optional().describe('Optional nested group containers.'),
      nodes: z.array(NodeSchema).min(1).describe('Diagram nodes with stable semantic IDs.'),
      edges: z.array(EdgeSchema).optional().describe('Directed or undirected edges between node IDs.'),
      style: StyleSchema.optional(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async ({ boardId, title, layout, placement, groups, nodes, edges, style }) => {
    try {
      const res = await applyDiagramSpec(
        { layout, groups, nodes, edges, style },
        { boardId, title, placement },
      );
      return ok(
        res,
        `Drew ${res.layout} diagram on "${res.title}" (${res.nodeCount} nodes, ${res.groupCount} groups, ${res.edgeCount} edges, rev ${res.rev}).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

registerAppTool(
  server,
  'replace_region',
  {
    title: 'Replace Selected Region',
    description:
      'Surgically replace a user-selected subset of elements while keeping all unselected elements locked, locally re-laying out the replacement with collision protection, and rebinding external boundary edges.',
    inputSchema: {
      boardId: z.string().describe('Target board ID.'),
      targetIds: z.array(z.string()).min(1).describe('IDs of selected elements to replace.'),
      replacement: z.object({
        layout: LayoutSchema,
        groups: z.array(GroupSchema).optional(),
        nodes: z.array(NodeSchema).min(1),
        edges: z.array(EdgeSchema).optional(),
        style: StyleSchema.optional(),
      }),
      rebindExternalEdges: z
        .array(
          z.object({
            edgeId: z.string(),
            end: z.enum(['start', 'end']),
            newNodeId: z.string(),
            label: z.string().optional(),
          }),
        )
        .optional()
        .describe('Reconnect external incoming/outgoing arrows to newly created nodes.'),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async ({ boardId, targetIds, replacement, rebindExternalEdges }) => {
    try {
      const board = await storage.loadBoard(boardId);
      const res = await replaceRegion(
        board.scene.elements,
        targetIds,
        replacement,
        rebindExternalEdges ?? [],
      );
      const { board: saved } = await storage.saveScene(board.meta.id, res.elements, {
        recordUndo: true,
      });
      return ok(
        {
          boardId: saved.meta.id,
          title: saved.meta.title,
          rev: saved.meta.rev,
          replacedCount: res.replacedCount,
          addedCount: res.addedCount,
          reboundEdges: res.reboundEdges,
          regionBounds: res.regionBounds,
        },
        `Replaced region on "${saved.meta.title}": removed ${res.replacedCount}, added ${res.addedCount} elements, rebound ${res.reboundEdges} external edges (rev ${saved.meta.rev}).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

registerAppTool(
  server,
  'patch_elements',
  {
    title: 'Patch Whiteboard Elements',
    description:
      'Apply fine-grained edits (rename labels, change colors/styles, nudge positions, add sticky notes/nodes/edges, or delete specific IDs) without re-laying out the rest of the board.',
    inputSchema: {
      boardId: z.string().optional(),
      addNodes: z.array(NodeSchema).optional(),
      addEdges: z.array(EdgeSchema).optional(),
      update: z
        .array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            tone: ToneSchema.optional(),
            dx: z.number().optional(),
            dy: z.number().optional(),
            strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
          }),
        )
        .optional(),
      deleteIds: z.array(z.string()).optional(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async ({ boardId, addNodes, addEdges, update, deleteIds }) => {
    try {
      const board = await storage.loadOrCreateBoard(boardId);
      const res = await patchElements(board.scene.elements, {
        addNodes,
        addEdges,
        update,
        deleteIds,
      });
      const { board: saved } = await storage.saveScene(board.meta.id, res.elements, {
        recordUndo: true,
      });
      return ok(
        {
          boardId: saved.meta.id,
          title: saved.meta.title,
          rev: saved.meta.rev,
          updatedCount: res.updatedCount,
          addedCount: res.addedCount,
          deletedCount: res.deletedCount,
        },
        `Patched "${saved.meta.title}": updated ${res.updatedCount}, added ${res.addedCount}, deleted ${res.deletedCount} (rev ${saved.meta.rev}).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

registerAppTool(
  server,
  'import_mermaid',
  {
    title: 'Import Mermaid to Whiteboard',
    description:
      'Convert a Mermaid flowchart/graph or sequenceDiagram into non-overlapping, editable Excalidraw elements on the whiteboard.',
    inputSchema: {
      boardId: z.string().optional(),
      title: z.string().optional(),
      mermaid: z.string().describe('Mermaid flowchart/graph or sequenceDiagram source text.'),
      placement: z.enum(['replace', 'append-right', 'append-below']).optional(),
    },
    _meta: {
      ui: { resourceUri: APP_URI },
    },
  },
  async ({ boardId, title, mermaid, placement }) => {
    try {
      const spec = parseMermaidToDiagramSpec(mermaid);
      if (spec.nodes.length === 0) {
        throw new Error('No nodes could be parsed from the provided Mermaid source.');
      }
      const res = await applyDiagramSpec(spec, { boardId, title, placement });
      return ok(
        res,
        `Imported Mermaid (${res.layout}) onto "${res.title}" with ${res.nodeCount} nodes and ${res.edgeCount} edges (rev ${res.rev}).`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

// 4. App-Only UI Tools (hidden from the model, zero context pollution)
const APP_ONLY = { ui: { visibility: ['app'] as ('app' | 'model')[] } };

server.registerTool(
  'app_list_boards',
  { title: 'App List Boards', inputSchema: {}, _meta: APP_ONLY },
  async () => {
    try {
      const boards = await storage.listBoards();
      return ok({ boards });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_load_board',
  {
    title: 'App Load Board',
    inputSchema: { boardId: z.string().optional() },
    _meta: APP_ONLY,
  },
  async ({ boardId }) => {
    try {
      const board = await storage.loadOrCreateBoard(boardId);
      const boards = await storage.listBoards();
      const poll = await storage.pollBoard(board.meta.id);
      return ok({ board, boards, canUndo: poll.canUndo });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_save_board',
  {
    title: 'App Save Board',
    inputSchema: {
      boardId: z.string(),
      elements: z.array(z.record(z.unknown())),
      expectedRev: z.number().optional(),
      appState: z.record(z.unknown()).optional(),
    },
    _meta: APP_ONLY,
  },
  async ({ boardId, elements, expectedRev, appState }) => {
    try {
      const res = await storage.saveScene(boardId, elements, {
        expectedRev,
        appState,
        recordUndo: false,
      });
      return ok({
        meta: res.board.meta,
        conflict: Boolean(res.conflict),
        scene: res.conflict ? res.board.scene : undefined,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_create_board',
  {
    title: 'App Create Board',
    inputSchema: { title: z.string() },
    _meta: APP_ONLY,
  },
  async ({ title }) => {
    try {
      const board = await storage.createBoard(title);
      const boards = await storage.listBoards();
      return ok({ board, boards });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_rename_board',
  {
    title: 'App Rename Board',
    inputSchema: { boardId: z.string(), title: z.string() },
    _meta: APP_ONLY,
  },
  async ({ boardId, title }) => {
    try {
      const meta = await storage.renameBoard(boardId, title);
      const boards = await storage.listBoards();
      return ok({ meta, boards });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_delete_board',
  {
    title: 'App Delete Board',
    inputSchema: { boardId: z.string() },
    _meta: APP_ONLY,
  },
  async ({ boardId }) => {
    try {
      await storage.deleteBoard(boardId);
      const fallback = await storage.ensureDefaultBoard();
      const boards = await storage.listBoards();
      return ok({ board: fallback, boards });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_undo_board',
  {
    title: 'App Undo AI Edit',
    inputSchema: { boardId: z.string() },
    _meta: APP_ONLY,
  },
  async ({ boardId }) => {
    try {
      const res = await storage.undoBoard(boardId);
      const poll = await storage.pollBoard(res.board.meta.id);
      return ok({ board: res.board, undone: res.undone, canUndo: poll.canUndo });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_poll_board',
  {
    title: 'App Poll Board Version',
    inputSchema: { boardId: z.string().optional() },
    _meta: APP_ONLY,
  },
  async ({ boardId }) => {
    try {
      const status = await storage.pollBoard(boardId);
      return ok(status as unknown as Record<string, unknown>);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_save_selection_snapshot',
  {
    title: 'App Save Selection PNG Snapshot',
    inputSchema: { base64Png: z.string() },
    _meta: APP_ONLY,
  },
  async ({ base64Png }) => {
    try {
      const snapshotPath = await storage.saveSelectionSnapshot(base64Png);
      return ok({ snapshotPath });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'app_export_to_workspace',
  {
    title: 'App Export Board to Workspace',
    inputSchema: {
      boardId: z.string(),
      format: z.enum(['excalidraw', 'svg', 'png']),
      content: z.string().optional(),
      targetPath: z.string().optional(),
    },
    _meta: APP_ONLY,
  },
  async ({ boardId, format, content, targetPath }) => {
    try {
      const res = await storage.exportToWorkspace(boardId, { format, content, targetPath });
      return ok(res);
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
