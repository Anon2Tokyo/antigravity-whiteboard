import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import {
  App as McpApp,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import type { McpUiHostCapabilities } from '@modelcontextprotocol/ext-apps';
import {
  ChevronDown,
  Copy,
  Download,
  Layers,
  Maximize2,
  Paperclip,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { BoardMeta, StoredBoard } from '../shared/dsl';
import { extractSelectionContext, formatSelectionContextForAI } from './selection-context';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to encode blob'));
    reader.readAsDataURL(blob);
  });
}

export default function App() {
  const mcpAppRef = useRef<McpApp | null>(null);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const inFlightRef = useRef(0);
  const queueRef = useRef<Array<() => void>>([]);

  // Sync & autosave tracking refs
  const currentBoardRef = useRef<StoredBoard | null>(null);
  const lastSavedSignatureRef = useRef<string>('');
  const suppressNextChangeRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  );
  const [hostCaps, setHostCaps] = useState<McpUiHostCapabilities | undefined>(undefined);

  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [activeBoard, setActiveBoard] = useState<StoredBoard | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Dropdown menus
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [busyAction, setBusyAction] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, isError = false) => {
    setToast({ message, isError });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  // Concurrency-safe MCP tool caller (<= 3 in flight, safely under Antigravity's 4-call cap)
  const callTool = useCallback(async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const app = mcpAppRef.current;
    if (!app) throw new Error('Not connected');
    if (inFlightRef.current >= 3) {
      await new Promise<void>((resolve) => queueRef.current.push(resolve));
    }
    inFlightRef.current++;
    try {
      const result = await app.callServerTool({ name, arguments: args });
      if (result.isError) {
        const msg =
          (result.structuredContent as { error?: string } | undefined)?.error ||
          (result.content?.[0] && 'text' in result.content[0] ? result.content[0].text : 'Tool failed');
        throw new Error(msg);
      }
      if (result.structuredContent !== undefined) {
        return result.structuredContent as T;
      }
      return {} as T;
    } finally {
      inFlightRef.current--;
      const next = queueRef.current.shift();
      if (next) next();
    }
  }, []);

  const computeSignature = (elements: readonly Record<string, unknown>[]): string => {
    let sum = 0;
    let count = 0;
    for (const el of elements) {
      if (el.isDeleted) continue;
      count++;
      sum = (sum + Number(el.version ?? 1) * 31 + Number(el.versionNonce ?? 0)) % 1_000_000_007;
    }
    return `${count}:${sum}`;
  };

  // Push loaded board scene into Excalidraw canvas
  const applyBoardToCanvas = useCallback(
    (board: StoredBoard, options?: { scrollToContent?: boolean }) => {
      currentBoardRef.current = board;
      setActiveBoard(board);
      const els = board.scene.elements ?? [];
      lastSavedSignatureRef.current = computeSignature(els);

      const api = excalidrawApiRef.current;
      if (api) {
        suppressNextChangeRef.current = true;
        api.updateScene({
          elements: els as never[],
          appState: {
            theme: dark ? 'dark' : 'light',
          },
        });
        if (options?.scrollToContent && els.length > 0) {
          window.setTimeout(() => {
            api.scrollToContent(els as never[], { fitToContent: true, animate: true });
          }, 40);
        }
        window.setTimeout(() => {
          suppressNextChangeRef.current = false;
        }, 120);
      }
    },
    [dark],
  );

  // Load a board from server
  const loadBoard = useCallback(
    async (boardId?: string, scrollToContent = true) => {
      try {
        const res = await callTool<{ board: StoredBoard; boards: BoardMeta[]; canUndo: boolean }>(
          'app_load_board',
          boardId ? { boardId } : {},
        );
        setBoards(res.boards ?? []);
        setCanUndo(Boolean(res.canUndo));
        applyBoardToCanvas(res.board, { scrollToContent });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to load board', true);
      }
    },
    [applyBoardToCanvas, callTool, showToast],
  );

  const loadBoardRef = useRef(loadBoard);
  loadBoardRef.current = loadBoard;

  // Connect MCP App SDK
  useEffect(() => {
    const app = new McpApp({ name: 'Antigravity Whiteboard', version: '0.1.0' }, {});
    mcpAppRef.current = app;

    const applyTheme = (
      theme?: string,
      variables?: Parameters<typeof applyHostStyleVariables>[0],
    ) => {
      if (theme === 'dark' || theme === 'light') {
        applyDocumentTheme(theme);
        document.documentElement.setAttribute('data-theme', theme);
        setDark(theme === 'dark');
      }
      if (variables) applyHostStyleVariables(variables);
    };

    // Register handlers BEFORE connect()
    app.ontoolresult = (result) => {
      const sc = result.structuredContent as { boardId?: string } | undefined;
      if (sc?.boardId) {
        loadBoardRef.current(sc.boardId, true);
      } else {
        loadBoardRef.current(undefined, true);
      }
    };

    app.onhostcontextchanged = (ctx) => {
      applyTheme(ctx.theme, ctx.styles?.variables);
    };

    app
      .connect()
      .then(() => {
        setConnected(true);
        const ctx = app.getHostContext();
        applyTheme(ctx?.theme, ctx?.styles?.variables);
        setHostCaps(app.getHostCapabilities());
        // Load active board even if launched with empty tool result
        loadBoardRef.current(undefined, true);
      })
      .catch((err) => {
        showToast(`Connect error: ${err instanceof Error ? err.message : String(err)}`, true);
      });
  }, [showToast]);

  // Sync data-theme attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }, [dark]);

  // When Excalidraw API mounts after board already loaded, hydrate it immediately
  const handleExcalidrawApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      excalidrawApiRef.current = api;
      const b = currentBoardRef.current;
      if (b && b.scene.elements.length > 0) {
        applyBoardToCanvas(b, { scrollToContent: true });
      }
    },
    [applyBoardToCanvas],
  );

  // Poll server every 1.5s to stay live-synced with AI edits & the other sidebar view
  useEffect(() => {
    if (!connected) return;
    const timer = window.setInterval(async () => {
      if (document.hidden || inFlightRef.current > 0 || saveTimerRef.current !== null) return;
      const cur = currentBoardRef.current;
      try {
        const poll = await callTool<{
          boardId: string;
          rev: number;
          title: string;
          canUndo: boolean;
        }>('app_poll_board', cur ? { boardId: cur.meta.id } : {});

        setCanUndo(Boolean(poll.canUndo));
        if (!cur || poll.boardId !== cur.meta.id || poll.rev > cur.meta.rev) {
          const isNewBoard = !cur || poll.boardId !== cur.meta.id || cur.scene.elements.length === 0;
          await loadBoard(poll.boardId, isNewBoard);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [callTool, connected, loadBoard]);

  // Handle user canvas edits & selection changes
  const handleCanvasChange = useCallback(
    (
      elements: readonly Record<string, unknown>[],
      appState: { selectedElementIds?: Record<string, boolean> },
    ) => {
      // Track selected element IDs cleanly
      const selMap = appState.selectedElementIds ?? {};
      const nextSelected = Object.keys(selMap).filter((k) => selMap[k]);
      setSelectedIds((prev) => {
        if (prev.length === nextSelected.length && prev.every((id, i) => id === nextSelected[i])) {
          return prev;
        }
        return nextSelected;
      });

      if (suppressNextChangeRef.current) return;
      const cur = currentBoardRef.current;
      if (!cur) return;

      const sig = computeSignature(elements);
      if (sig === lastSavedSignatureRef.current) return;

      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = window.setTimeout(async () => {
        saveTimerRef.current = null;
        const latestBoard = currentBoardRef.current;
        if (!latestBoard) return;
        const activeElements = elements.filter((e) => !e.isDeleted) as Record<string, unknown>[];
        try {
          const res = await callTool<{
            meta: BoardMeta;
            conflict?: boolean;
            scene?: StoredBoard['scene'];
          }>('app_save_board', {
            boardId: latestBoard.meta.id,
            elements: activeElements,
            expectedRev: latestBoard.meta.rev,
          });
          if (res.conflict && res.scene) {
            // AI wrote a newer revision while user edited — pull latest
            applyBoardToCanvas({ meta: res.meta, scene: res.scene }, { scrollToContent: false });
            showToast('Synced newer AI update');
          } else {
            lastSavedSignatureRef.current = computeSignature(activeElements);
            const nextBoard: StoredBoard = {
              meta: res.meta,
              scene: { ...latestBoard.scene, elements: activeElements },
            };
            currentBoardRef.current = nextBoard;
            setActiveBoard(nextBoard);
          }
        } catch {
          // Ignore autosave error
        }
      }, 650);
    },
    [applyBoardToCanvas, callTool, showToast],
  );

  // Build precision selection context (+ optional local PNG snapshot)
  const buildSelectionPayload = useCallback(
    async (includeSnapshot: boolean) => {
      const api = excalidrawApiRef.current;
      const board = currentBoardRef.current;
      if (!api || !board) return null;

      const allElements = api.getSceneElements() as unknown as Record<string, unknown>[];
      const selSet = new Set(selectedIds);
      if (selSet.size === 0) return null;

      let snapshotPath: string | undefined;
      if (includeSnapshot) {
        try {
          const selectedEls = allElements.filter((el) => {
            if (el.isDeleted) return false;
            const id = String(el.id);
            return selSet.has(id) || (typeof el.containerId === 'string' && selSet.has(el.containerId));
          });
          if (selectedEls.length > 0) {
            const blob = await exportToBlob({
              elements: selectedEls as never[],
              appState: {
                exportWithDarkMode: dark,
                exportBackground: true,
                viewBackgroundColor: dark ? '#121212' : '#ffffff',
              },
              files: api.getFiles(),
              exportPadding: 48,
            });
            const dataUrl = await blobToBase64(blob);
            const saved = await callTool<{ snapshotPath: string }>('app_save_selection_snapshot', {
              base64Png: dataUrl,
            });
            snapshotPath = saved.snapshotPath;
          }
        } catch {
          // Snapshot is optional enhancement; proceed with structured JSON
        }
      }

      const ctx = extractSelectionContext(
        board.meta.id,
        board.meta.title,
        allElements,
        selSet,
        snapshotPath,
      );
      return ctx;
    },
    [callTool, dark, selectedIds],
  );

  const handleAttachSelection = useCallback(async () => {
    const app = mcpAppRef.current;
    if (!app || selectedIds.length === 0) return;
    setBusyAction(true);
    try {
      const ctx = await buildSelectionPayload(true);
      if (!ctx) return;
      const text = formatSelectionContextForAI(ctx);
      await app.updateModelContext({ content: [{ type: 'text', text }] });
      showToast(`Attached ${ctx.selectedElements.length} selected element(s) to next message`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Attach failed', true);
    } finally {
      setBusyAction(false);
    }
  }, [buildSelectionPayload, selectedIds.length, showToast]);

  const handleAskAiSelection = useCallback(async () => {
    const app = mcpAppRef.current;
    if (!app || selectedIds.length === 0) return;
    setBusyAction(true);
    try {
      const ctx = await buildSelectionPayload(true);
      if (!ctx) return;
      const text = `${formatSelectionContextForAI(ctx)}\n\nPlease inspect this selected whiteboard region and suggest or apply improvements.`;
      const res = await app.sendMessage({
        role: 'user',
        content: [{ type: 'text', text }],
      });
      if (res.isError) {
        showToast('Host declined message', true);
      } else {
        showToast('Sent selection to Antigravity');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Send failed', true);
    } finally {
      setBusyAction(false);
    }
  }, [buildSelectionPayload, selectedIds.length, showToast]);

  const handleCopySelection = useCallback(async () => {
    if (selectedIds.length === 0) return;
    setBusyAction(true);
    try {
      const ctx = await buildSelectionPayload(true);
      if (!ctx) return;
      const text = formatSelectionContextForAI(ctx);
      await navigator.clipboard.writeText(text);
      showToast(`Copied ${ctx.selectedElements.length} selected element(s) context`);
    } catch {
      showToast('Clipboard copy blocked in this view', true);
    } finally {
      setBusyAction(false);
    }
  }, [buildSelectionPayload, selectedIds.length, showToast]);

  const handleUndoAi = useCallback(async () => {
    const board = currentBoardRef.current;
    if (!board) return;
    try {
      const res = await callTool<{ board: StoredBoard; undone: boolean; canUndo: boolean }>(
        'app_undo_board',
        { boardId: board.meta.id },
      );
      setCanUndo(Boolean(res.canUndo));
      if (res.undone) {
        applyBoardToCanvas(res.board, { scrollToContent: false });
        showToast('Reverted previous AI edit');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Undo failed', true);
    }
  }, [applyBoardToCanvas, callTool, showToast]);

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newBoardTitle.trim() || `Board ${boards.length + 1}`;
    try {
      const res = await callTool<{ board: StoredBoard; boards: BoardMeta[] }>('app_create_board', {
        title,
      });
      setBoards(res.boards ?? []);
      applyBoardToCanvas(res.board, { scrollToContent: false });
      setNewBoardTitle('');
      setBoardMenuOpen(false);
      showToast(`Created "${res.board.meta.title}"`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Create failed', true);
    }
  };

  const handleDeleteBoard = async (boardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this board?')) return;
    try {
      const res = await callTool<{ board: StoredBoard; boards: BoardMeta[] }>('app_delete_board', {
        boardId,
      });
      setBoards(res.boards ?? []);
      applyBoardToCanvas(res.board, { scrollToContent: true });
      showToast('Board deleted');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Delete failed', true);
    }
  };

  const handleExportWorkspace = async (format: 'excalidraw' | 'svg' | 'png') => {
    const api = excalidrawApiRef.current;
    const board = currentBoardRef.current;
    if (!api || !board) return;
    setExportMenuOpen(false);

    try {
      const els = api.getSceneElements();
      let content: string | undefined;
      if (format === 'svg') {
        const svg = await exportToSvg({
          elements: els,
          appState: {
            exportWithDarkMode: dark,
            exportBackground: true,
            viewBackgroundColor: dark ? '#121212' : '#ffffff',
          },
          files: api.getFiles(),
          exportPadding: 32,
        });
        content = new XMLSerializer().serializeToString(svg);
      } else if (format === 'png') {
        const blob = await exportToBlob({
          elements: els,
          appState: {
            exportWithDarkMode: dark,
            exportBackground: true,
            viewBackgroundColor: dark ? '#121212' : '#ffffff',
          },
          files: api.getFiles(),
          exportPadding: 32,
        });
        content = await blobToBase64(blob);
      }

      const res = await callTool<{ savedPath: string }>('app_export_to_workspace', {
        boardId: board.meta.id,
        format,
        content,
      });
      showToast(`Saved to ${res.savedPath}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Export failed', true);
    }
  };

  const handleFitView = () => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: true });
  };

  return (
    <div className="wb-shell" onClick={() => { setBoardMenuOpen(false); setExportMenuOpen(false); }}>
      <header className="wb-topbar">
        <div className="wb-topbar-left">
          <div className="wb-board-picker" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="wb-btn bordered"
              onClick={() => { setBoardMenuOpen((v) => !v); setExportMenuOpen(false); }}
            >
              <Layers size={13} style={{ color: 'var(--wb-accent)' }} />
              <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {activeBoard?.meta.title || (connected ? 'Loading...' : 'Connecting...')}
              </span>
              <ChevronDown size={12} />
            </button>

            {boardMenuOpen && (
              <div className="wb-dropdown">
                <form className="wb-create-row" onSubmit={handleCreateBoard}>
                  <input
                    className="wb-input"
                    value={newBoardTitle}
                    onChange={(e) => setNewBoardTitle(e.target.value)}
                    placeholder="New whiteboard name..."
                  />
                  <button type="submit" className="wb-btn primary" title="Create board">
                    <Plus size={13} />
                  </button>
                </form>

                {boards.map((b) => (
                  <div
                    key={b.id}
                    className={`wb-board-item ${b.id === activeBoard?.meta.id ? 'active' : ''}`}
                    onClick={() => {
                      loadBoard(b.id, true);
                      setBoardMenuOpen(false);
                    }}
                  >
                    <div className="wb-board-item-info">
                      <div className="wb-board-item-title">{b.title}</div>
                      <div className="wb-board-item-meta">
                        {b.elementCount} elements · rev {b.rev}
                      </div>
                    </div>
                    {boards.length > 1 && (
                      <button
                        type="button"
                        className="wb-btn"
                        title="Delete board"
                        onClick={(e) => handleDeleteBoard(b.id, e)}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {activeBoard && (
            <span className="wb-rev-badge" title={`Board ID: ${activeBoard.meta.id}`}>
              v{activeBoard.meta.rev}
            </span>
          )}
        </div>

        <div className="wb-topbar-right">
          {selectedIds.length > 0 && (
            <>
              <span className="wb-selection-pill">{selectedIds.length} selected</span>

              {hostCaps?.updateModelContext ? (
                <button
                  type="button"
                  className="wb-btn pill-highlight"
                  disabled={busyAction}
                  title="Attach selected region (IDs + boundary edges + PNG snapshot) to next chat message"
                  onClick={handleAttachSelection}
                >
                  <Paperclip size={13} />
                  <span>Attach</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="wb-btn pill-highlight"
                  disabled={busyAction}
                  title="Copy selected region context (IDs + boundary edges + snapshot path) for AI chat"
                  onClick={handleCopySelection}
                >
                  <Copy size={13} />
                  <span>Copy Context</span>
                </button>
              )}

              {hostCaps?.message && (
                <button
                  type="button"
                  className="wb-btn bordered"
                  disabled={busyAction}
                  title="Send selected region directly to Antigravity"
                  onClick={handleAskAiSelection}
                >
                  <Sparkles size={13} />
                </button>
              )}
            </>
          )}

          {canUndo && (
            <button
              type="button"
              className="wb-btn"
              title="Revert last AI diagram change"
              onClick={handleUndoAi}
            >
              <RotateCcw size={13} />
            </button>
          )}

          <button
            type="button"
            className="wb-btn"
            title="Fit diagram to viewport"
            onClick={handleFitView}
          >
            <Maximize2 size={13} />
          </button>

          <div className="wb-board-picker" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="wb-btn"
              title="Save board to current workspace (docs/diagrams/)"
              onClick={() => { setExportMenuOpen((v) => !v); setBoardMenuOpen(false); }}
            >
              <Download size={13} />
            </button>

            {exportMenuOpen && (
              <div className="wb-dropdown right">
                <div className="wb-board-item" onClick={() => handleExportWorkspace('excalidraw')}>
                  <div className="wb-board-item-title">Save .excalidraw to project</div>
                </div>
                <div className="wb-board-item" onClick={() => handleExportWorkspace('svg')}>
                  <div className="wb-board-item-title">Export .svg to project</div>
                </div>
                <div className="wb-board-item" onClick={() => handleExportWorkspace('png')}>
                  <div className="wb-board-item-title">Export .png to project</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="wb-canvas-wrap">
        <Excalidraw
          excalidrawAPI={handleExcalidrawApi}
          theme={dark ? 'dark' : 'light'}
          onChange={handleCanvasChange as never}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        />
      </div>

      {toast && <div className={`wb-toast ${toast.isError ? 'error' : ''}`}>{toast.message}</div>}
    </div>
  );
}
