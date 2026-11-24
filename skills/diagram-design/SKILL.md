---
name: diagram-design
description: Guide for drawing clean, varied, non-overlapping architecture diagrams, data flow diagrams, module blueprints, topology graphs, and sequence diagrams on the Antigravity Whiteboard MCP App, and performing precision local edits from user box-selections.
---

# Antigravity Whiteboard Diagram Design Guide

Use the `antigravity-whiteboard` MCP tools (`draw_diagram`, `replace_region`, `patch_elements`, `get_board_summary`, `import_mermaid`) to create native editable Excalidraw diagrams instead of static text blocks whenever visual structure helps.

## 1. Choose the Right Layout for the Diagram's Intent (Avoid Monotonous Diagrams)

Never default every diagram to the same top-to-bottom stack of boxes. Pick the layout strategy that matches the mental model:

| User Request / Intent | Layout | Visual Guidelines |
| :--- | :--- | :--- |
| **Data flow / Pipeline / ETL / Request lifecycle** | `layered-lr` | Left-to-right flow; mark the primary hot path with `emphasis: "primary"`, branches with `shape: "diamond"`, async queues with `shape: "queue"` + `lineStyle: "dashed"`. |
| **System architecture / Deployment / Layered stack** | `layered-tb` | Group components into nested `groups` (e.g. Client, Edge, Core Services, Data); use `shape: "database"` for stores and `tone` to separate layers cleanly. |
| **Module map / Feature panorama / Codebase blueprint** | `box` | Pack sub-modules inside parent module `groups` like a technical blueprint; omit noisy edges or keep only key cross-module links. |
| **Microservice mesh / Dependency web** | `stress` | Natural cluster topology for many-to-many dependencies without artificial grid rows. |
| **Component hierarchy / Directory tree / Mindmap** | `mrtree` | Clean parent-child branching with zero crossings. |
| **Protocol handshake / Multi-actor timeline** | `sequence` | Ordered vertical lifelines with numbered horizontal request/response arrows. |
| **Side-by-side comparison / Quadrants / Custom sketch** | `free` | Provide approximate relative `x`/`y` anchors or zones; server enforces text sizing and collision resolution. |

Tip: You can place two complementary views on the same infinite canvas by calling `draw_diagram` once (`placement: "replace"`) and then calling it again with `placement: "append-right"` or `"append-below"`.

## 2. Keep Diagrams Clean & Readable

- **Concise labels**: Put the short component name in `label` (1-4 words) and brief tech/role detail in `sublabel` (e.g. `label: "Order Service"`, `sublabel: "Go · gRPC"`). Avoid dumping paragraphs inside boxes.
- **Stable semantic IDs**: Always use readable IDs (`node_gateway`, `group_data`, `edge_gw_auth`) so future local edits stay surgical.
- **Semantic color palette**: Use distinct `tone` values by layer or role (`blue` ingress/UI, `purple` core logic, `green` storage/data, `amber` queues/async/notes, `teal` external/infra, `rose` alerts/critical).
- **Edge semantics**: `solid` = synchronous call, `dashed` = async/event/cache, `dotted` = optional/weak dependency, `emphasis: "primary"` = main path.

## 3. Precision Local Editing (When User Box-Selects a Region)

When the user attaches a Whiteboard selection context (`selectedElements`, `selectionBox`, `externalBoundaryEdges`, `nearbyObstacles`, and optional `snapshotPath`):

1. **Inspect visually if needed**: If `snapshotPath` is present and the user mentions layout quality, crowding, or aesthetics, call `read_file` on `snapshotPath` first so you can see the exact visual state.
2. **Use `replace_region` for structural redesign of the selected area**:
   - Pass all IDs from `selectedElements` in `targetIds` so everything outside the selection stays locked and untouched.
   - Provide `replacement` (`layout`, `groups`, `nodes`, `edges`) for only the redesigned region.
   - Pass `rebindExternalEdges` for every edge in `externalBoundaryEdges` that should reconnect to your new entry/exit node IDs so no dangling arrows remain!
3. **Use `patch_elements` for small tweaks**: Renaming labels, recoloring nodes, changing edge styles, adding a single sticky note, or deleting a specific element without moving anything.
4. **Always inspect before editing blindly**: If the user refers to an existing board without a selection attachment, call `get_board_summary` first to get exact element IDs.
