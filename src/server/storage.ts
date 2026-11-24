import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardMeta, ExcalidrawSceneFile, StoredBoard } from '../shared/dsl.js';

const MAX_UNDO_DEPTH = 20;
const MAX_SNAPSHOTS = 30;

function getArgDataDir(): string | null {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--data-dir=')) {
      const val = arg.slice('--data-dir='.length).trim();
      if (val && !val.includes('${PLUGIN_DATA}')) return val;
    }
  }
  return null;
}

export function resolveDataDir(): string {
  const fromArg = getArgDataDir();
  if (fromArg) return path.resolve(fromArg);
  if (process.env.ANTIGRAVITY_WHITEBOARD_DATA_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_WHITEBOARD_DATA_DIR);
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'plugin_data', 'antigravity-whiteboard');
}

function sanitizeBoardId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return cleaned || `board_${Date.now()}`;
}

export function createEmptyScene(): ExcalidrawSceneFile {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'antigravity-whiteboard',
    elements: [],
    appState: {
      gridSize: null,
      viewBackgroundColor: '#ffffff',
    },
    files: {},
  };
}

export class BoardStorage {
  readonly dataDir: string;
  readonly boardsDir: string;
  readonly snapshotsDir: string;
  private undoStacks = new Map<string, ExcalidrawSceneFile[]>();
  private activeBoardId: string | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ? path.resolve(dataDir) : resolveDataDir();
    this.boardsDir = path.join(this.dataDir, 'boards');
    this.snapshotsDir = path.join(this.dataDir, 'snapshots');
    fs.mkdirSync(this.boardsDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
  }

  private boardFilePath(boardId: string): string {
    return path.join(this.boardsDir, `${sanitizeBoardId(boardId)}.board.json`);
  }

  async listBoards(): Promise<BoardMeta[]> {
    const files = await fsp.readdir(this.boardsDir);
    const metas: BoardMeta[] = [];

    for (const file of files) {
      if (!file.endsWith('.board.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(this.boardsDir, file), 'utf8');
        const parsed = JSON.parse(raw) as StoredBoard;
        if (parsed?.meta?.id) {
          metas.push(parsed.meta);
        }
      } catch {
        // Ignore corrupted files
      }
    }

    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  async ensureDefaultBoard(): Promise<StoredBoard> {
    if (this.activeBoardId) {
      const existing = await this.loadBoard(this.activeBoardId).catch(() => null);
      if (existing) return existing;
    }
    const list = await this.listBoards();
    if (list.length > 0) {
      const loaded = await this.loadBoard(list[0].id);
      this.activeBoardId = loaded.meta.id;
      return loaded;
    }
    return this.createBoard('Architecture Whiteboard');
  }

  async createBoard(title: string, requestedId?: string): Promise<StoredBoard> {
    const id = sanitizeBoardId(requestedId || `board_${Date.now().toString(36)}`);
    const now = new Date().toISOString();
    const board: StoredBoard = {
      meta: {
        id,
        title: title.trim() || 'Untitled Board',
        rev: 1,
        elementCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      scene: createEmptyScene(),
    };
    await this.writeBoardFile(board);
    this.activeBoardId = id;
    return board;
  }

  async loadBoard(boardId: string): Promise<StoredBoard> {
    const fp = this.boardFilePath(boardId);
    const raw = await fsp.readFile(fp, 'utf8');
    const parsed = JSON.parse(raw) as StoredBoard;
    this.activeBoardId = parsed.meta.id;
    return parsed;
  }

  async loadOrCreateBoard(boardId?: string, title?: string): Promise<StoredBoard> {
    if (boardId) {
      try {
        const existing = await this.loadBoard(boardId);
        if (title && title.trim() && existing.meta.title !== title.trim()) {
          existing.meta.title = title.trim();
        }
        return existing;
      } catch {
        return this.createBoard(title || boardId, boardId);
      }
    }
    const board = await this.ensureDefaultBoard();
    if (title && title.trim()) {
      board.meta.title = title.trim();
    }
    return board;
  }

  private pushUndo(boardId: string, scene: ExcalidrawSceneFile): void {
    const stack = this.undoStacks.get(boardId) ?? [];
    stack.push(structuredClone(scene));
    if (stack.length > MAX_UNDO_DEPTH) stack.shift();
    this.undoStacks.set(boardId, stack);
  }

  async saveScene(
    boardId: string,
    elements: Record<string, unknown>[],
    options?: {
      title?: string;
      appState?: Record<string, unknown>;
      files?: Record<string, unknown>;
      recordUndo?: boolean;
      expectedRev?: number;
    },
  ): Promise<{ board: StoredBoard; conflict?: boolean }> {
    const existing = await this.loadOrCreateBoard(boardId, options?.title);

    // Optimistic concurrency guard: if UI sends stale expectedRev while AI wrote a newer rev,
    // reject silent overwrite so AI edits are never clobbered by debounced autosave.
    if (typeof options?.expectedRev === 'number' && options.expectedRev < existing.meta.rev) {
      return { board: existing, conflict: true };
    }

    if (options?.recordUndo) {
      this.pushUndo(existing.meta.id, existing.scene);
    }

    const activeCount = elements.filter((el) => !el.isDeleted).length;
    const updated: StoredBoard = {
      meta: {
        ...existing.meta,
        title: options?.title?.trim() || existing.meta.title,
        rev: existing.meta.rev + 1,
        elementCount: activeCount,
        updatedAt: new Date().toISOString(),
      },
      scene: {
        type: 'excalidraw',
        version: 2,
        source: 'antigravity-whiteboard',
        elements,
        appState: options?.appState
          ? { ...existing.scene.appState, ...options.appState }
          : existing.scene.appState,
        files: options?.files ?? existing.scene.files ?? {},
      },
    };

    await this.writeBoardFile(updated);
    this.activeBoardId = updated.meta.id;
    return { board: updated };
  }

  async renameBoard(boardId: string, newTitle: string): Promise<BoardMeta> {
    const existing = await this.loadBoard(boardId);
    existing.meta.title = newTitle.trim() || existing.meta.title;
    existing.meta.rev += 1;
    existing.meta.updatedAt = new Date().toISOString();
    await this.writeBoardFile(existing);
    return existing.meta;
  }

  async deleteBoard(boardId: string): Promise<{ deleted: string }> {
    const fp = this.boardFilePath(boardId);
    await fsp.rm(fp, { force: true });
    this.undoStacks.delete(boardId);
    if (this.activeBoardId === boardId) {
      this.activeBoardId = null;
    }
    return { deleted: boardId };
  }

  async undoBoard(boardId: string): Promise<{ board: StoredBoard; undone: boolean }> {
    const existing = await this.loadBoard(boardId);
    const stack = this.undoStacks.get(existing.meta.id);
    if (!stack || stack.length === 0) {
      return { board: existing, undone: false };
    }
    const prevScene = stack.pop()!;
    const activeCount = prevScene.elements.filter((el) => !el.isDeleted).length;
    const restored: StoredBoard = {
      meta: {
        ...existing.meta,
        rev: existing.meta.rev + 1,
        elementCount: activeCount,
        updatedAt: new Date().toISOString(),
      },
      scene: prevScene,
    };
    await this.writeBoardFile(restored);
    return { board: restored, undone: true };
  }

  async pollBoard(boardId?: string): Promise<{
    boardId: string;
    rev: number;
    title: string;
    updatedAt: string;
    canUndo: boolean;
  }> {
    const targetId = boardId || this.activeBoardId;
    const board = targetId
      ? await this.loadBoard(targetId).catch(() => this.ensureDefaultBoard())
      : await this.ensureDefaultBoard();
    const canUndo = (this.undoStacks.get(board.meta.id)?.length ?? 0) > 0;
    return {
      boardId: board.meta.id,
      rev: board.meta.rev,
      title: board.meta.title,
      updatedAt: board.meta.updatedAt,
      canUndo,
    };
  }

  async saveSelectionSnapshot(base64Png: string): Promise<string> {
    const cleaned = base64Png.replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(cleaned, 'base64');
    const filename = `sel_${Date.now()}.png`;
    const fullPath = path.join(this.snapshotsDir, filename);
    await fsp.writeFile(fullPath, buf);

    // Prune older snapshots
    try {
      const files = (await fsp.readdir(this.snapshotsDir))
        .filter((f) => f.endsWith('.png'))
        .sort();
      if (files.length > MAX_SNAPSHOTS) {
        const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS);
        await Promise.all(toDelete.map((f) => fsp.rm(path.join(this.snapshotsDir, f), { force: true })));
      }
    } catch {
      // Ignore cleanup errors
    }

    return fullPath;
  }

  async detectRecentWorkspaceDir(): Promise<string | null> {
    const dbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) return null;
    try {
      const sqlite = await import('node:sqlite');
      const db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
      try {
        const rows = db
          .prepare(
            `SELECT workspace_uris FROM conversation_summaries
             WHERE workspace_uris IS NOT NULL AND workspace_uris != '' AND workspace_uris != '[]'
             ORDER BY last_modified_time DESC LIMIT 10`,
          )
          .all() as Array<{ workspace_uris?: string }>;
        for (const r of rows) {
          if (!r.workspace_uris) continue;
          const uris = JSON.parse(r.workspace_uris);
          if (!Array.isArray(uris)) continue;
          for (const uri of uris) {
            if (typeof uri !== 'string') continue;
            try {
              const p = uri.startsWith('file://') ? fileURLToPath(uri) : path.resolve(uri);
              if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
            } catch {
              // skip
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
    return null;
  }

  async exportToWorkspace(
    boardId: string,
    options: {
      format: 'excalidraw' | 'svg' | 'png';
      content?: string;
      targetPath?: string;
    },
  ): Promise<{ savedPath: string }> {
    const board = await this.loadBoard(boardId);
    const safeSlug = board.meta.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || board.meta.id;

    let outPath: string;
    if (options.targetPath && options.targetPath.trim()) {
      outPath = path.resolve(options.targetPath.trim());
    } else {
      const wsRoot = (await this.detectRecentWorkspaceDir()) || process.cwd();
      outPath = path.join(wsRoot, 'docs', 'diagrams', `${safeSlug}.${options.format}`);
    }

    await fsp.mkdir(path.dirname(outPath), { recursive: true });

    if (options.format === 'excalidraw') {
      await fsp.writeFile(outPath, JSON.stringify(board.scene, null, 2), 'utf8');
    } else if (options.format === 'svg') {
      if (!options.content) throw new Error('SVG content is required');
      await fsp.writeFile(outPath, options.content, 'utf8');
    } else if (options.format === 'png') {
      if (!options.content) throw new Error('PNG base64 content is required');
      const cleaned = options.content.replace(/^data:image\/png;base64,/, '');
      await fsp.writeFile(outPath, Buffer.from(cleaned, 'base64'));
    }

    return { savedPath: outPath };
  }

  private async writeBoardFile(board: StoredBoard): Promise<void> {
    const fp = this.boardFilePath(board.meta.id);
    const tmp = `${fp}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(board, null, 2), 'utf8');
    await fsp.rename(tmp, fp);
  }
}
