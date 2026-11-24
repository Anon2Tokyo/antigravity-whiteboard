# Antigravity Whiteboard

An AI-drawable **Excalidraw** whiteboard **MCP App** plugin for **Google Antigravity** with a multi-layout **ELK.js** anti-overlap engine and surgical **box-selection local editing**.

## Highlights

- **Left + Right Sidebar Entrypoints**:
  - **Left Sidebar (`global`)**: Full-page infinite canvas for inspecting large diagrams, freehand editing, and managing multiple boards.
  - **Right Sidebar (`aux_pane`)**: Companion canvas bound to the active conversation with instant AI updates and one-click **Attach Selection**.
  - Both surfaces stay live-synced through shared local storage (`${PLUGIN_DATA}/boards/`).
- **No Template Lock-In — 7 Layout Strategies**:
  - `layered-tb`: Layered system architecture & deployment diagrams (nested groups + orthogonal obstacle-avoiding arrows)
  - `layered-lr`: Left-to-right data flow diagrams (DFD), pipelines, and ETL flows
  - `box`: Nested module & capability blueprints (compact rectpacking matrix)
  - `stress`: Natural cluster topology for microservice / dependency meshes
  - `mrtree`: Clean hierarchical trees & mindmaps
  - `sequence`: Request interaction timelines with lifelines and numbered horizontal arrows
  - `free`: Custom zones/comparisons with automatic text sizing and AABB collision resolution
  - Plus multi-zone placement (`replace`, `append-right`, `append-below`) and `import_mermaid`.
- **Mathematical Anti-Overlap & Native Excalidraw Bindings**:
  - Server-side CJK/Latin text measurement + `ELK.js` compound layout + 90° orthogonal edge routing.
  - Compiles to 100% native Excalidraw v2 elements (`containerId` bound labels, `startBinding`/`endBinding` arrows), so dragging any node moves its labels and arrows automatically.
- **Precision Box-Selection Local Editing**:
  - Box-select any region on the canvas and click **Attach** (or **Copy Context** in global view).
  - Extracts exact semantic element IDs, selection bounding box, **external boundary edges** (incoming/outgoing connections to unselected neighbors), nearby obstacles, and an optional **PNG visual snapshot**.
  - `replace_region` locks everything outside your selection, re-lays out only the selected area with collision protection, and cleanly rebinds external boundary arrows.
- **100% Offline & CSP-Safe**: Single-file HTML bundle (~3.6 MiB) with bundled local fonts and zero external CDN calls.
- **Bundled Skill (`skills/diagram-design/SKILL.md`)**: Teaches Antigravity how to pick the best layout strategy and perform surgical local edits.

## Installation

### Option 1: Clone directly as a plugin (Quickest)

Requires **Node.js 20+**.

```bash
git clone https://github.com/Anon2Tokyo/antigravity-whiteboard.git ~/.gemini/config/plugins/antigravity-whiteboard
```

### Option 2: Build from source & install

```bash
git clone https://github.com/Anon2Tokyo/antigravity-whiteboard.git
cd antigravity-whiteboard
npm install
npm run install-plugin
```

## Usage in Antigravity

1. Open **Whiteboard** from Antigravity's **left sidebar** (full-page) or the **right sidebar `+` menu** (companion mode).
2. Ask Antigravity to draw diagrams, for example:
   - *"Read `src/` and draw a layered architecture diagram on the whiteboard."*
   - *"Draw a left-to-right data flow diagram showing how requests are processed."*
   - *"Map out the project modules as a `box` module blueprint."*
3. **Precision local edits**: Box-select any part of the diagram you want refined → click **Attach** → tell Antigravity what to change. Only the selected region updates while external nodes stay locked and connected.
4. Click the export button in the toolbar to save `.excalidraw`, `.svg`, or `.png` directly into your active project's `docs/diagrams/` directory.

## Architecture

See [DESIGN.md](./DESIGN.md) for full architecture, anti-overlap pipeline, selection protocol, and MCP tool specifications.

## Development

```bash
npm run typecheck      # TypeScript checks
npm run build          # Build dist/index.html & dist/server.mjs
npm test               # Run end-to-end MCP & anti-overlap smoke tests
npm run install-plugin # Build & install into ~/.gemini/config/plugins/antigravity-whiteboard
```

## License

MIT
