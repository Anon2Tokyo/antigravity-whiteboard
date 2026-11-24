# Antigravity Whiteboard — 架构与交互设计文档 (DESIGN.md)

## 1. 背景与目标

在 Google Antigravity 中讨论系统架构、数据流向、模块拆分和交互流程时，纯文本或静态 Mermaid 存在两个核心痛点：
1. **只能看不能改**：生成完之后无法手动拖拽微调、批注或二次加工；
2. **局部修改困难**：当图中只有一小块不满意时，很难只让 AI 重画局部而不破坏整体布局。

**Antigravity Whiteboard** 是一个基于 **MCP Apps (SEP-1865)** 的开源插件，将 **Excalidraw 矢量白板** 深度集成到 Antigravity 的 **左侧栏（全屏画布 `global`）** 和 **右侧栏（对话伴随面板 `aux_pane`）**，实现“AI 直接画 + 人工随时拖 + 框选局部精改”的双向协作闭环。

### 核心设计原则
- **拒绝单一死模板**：提供自由图形积木 + 6 种数学布局策略，让架构图、数据流向图、功能模块图、依赖拓扑图、时序交互图各有最贴切的空间结构。
- **数学级防重叠与避障走线**：AI 只输出高层语义结构（节点、分组、连线、布局策略），坐标计算、嵌套尺寸撑开、90° 正交避障走线和碰撞保护全部由服务端 `ELK.js` 与碰撞求解器完成。
- **100% 原生 Excalidraw 元素**：AI 生成的所有图形均写入完整 `startBinding` / `endBinding` / `containerId` / `groupIds`，生成后拖拽任何节点，连线和文字都会原生跟随。
- **手术级局部框选修改**：用户在画板上框选任意区域，一键附加给 AI（附带精确语义 ID + 外部边界连线 + 局部包围盒 + 可选局部 PNG 快照），AI 仅修改框选区域并自动重接外部连线，框外元素纹丝不动。
- **零上下文污染**：所有纯 UI 读写/轮询工具标记 `visibility: ["app"]`，不暴露给模型；给模型读取画布时只返回精简的空间语义摘要，不倾倒原始几十 KB 的底层 Excalidraw JSON。

---

## 2. 系统总体架构

整个插件通过 stdio MCP 协议运行，**无需占用任何本地 HTTP 端口**。

```text
┌──────────────────────────────────────────────────────────────────────┐
│                       Google Antigravity Host                        │
│                                                                      │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  左侧栏 Global 全屏画布       │  │  右侧栏 Aux Pane 伴随画布     │  │
│  │  (大空间精修 / 多画板管理)     │  │  (边聊边画 / 框选 Attach AI)  │  │
│  └──────────────┬───────────────┘  └──────────────┬───────────────┘  │
│                 │  postMessage (JSON-RPC)         │  + updateModelContext
│                 └────────────────┬────────────────┘  + sendMessage   │
│                                  ▼                                   │
│                     [ Antigravity MCP Apps Bridge ]                  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ stdio (MCP)
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Local MCP Server (Node.js, dist/server.mjs)             │
│                                                                      │
│  ┌───────────────────┐  ┌────────────────────┐  ┌─────────────────┐  │
│  │  AI 绘图工具层     │  │ 布局与防重叠引擎    │  │  画布持久化层    │  │
│  │ - open_whiteboard │  │ - 中英文文本测宽    │  │ ${PLUGIN_DATA}/ │  │
│  │ - draw_diagram    ├─►│ - ELK.js 多布局引擎 ├─►│   boards/*.json │  │
│  │ - replace_region  │  │ - 正交避障走线      │  │   snapshots/    │  │
│  │ - patch_elements  │  │ - 局部碰撞推开求解  │  │                 │  │
│  │ - get_board_summary│ │ - Excalidraw 编译器 │  │ 可选导出到工作区 │  │
│  │ - import_mermaid  │  └────────────────────┘  │ (.excalidraw /  │  │
│  └───────────────────┘                          │  .svg / .png)   │  │
│  ┌───────────────────┐                          └─────────────────┘  │
│  │ App-only UI 工具   │ (visibility: ["app"], 模型不可见)             │
│  │ - app_load/save   │                                               │
│  │ - app_poll_version│  ◄── 左侧栏 & 右侧栏自动保持同一画布实时同步    │
│  │ - app_save_snapshot                                               │
│  └───────────────────┘                                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 双入口协同机制
| 视图入口 | 宿主能力 | 定位与职责 |
| :--- | :--- | :--- |
| **左侧栏 `global`** | 全屏大画布（无绑定会话） | 适合查看/精修复杂大图、管理多画板目录、自由手绘；选中元素提供 **Copy Selection Context** 一键复制上下文。 |
| **右侧栏 `aux_pane`** | 绑定当前对话（支持 `updateModelContext` / `sendMessage` / AI 自动打开更新） | 适合边对话边画图；AI 调用绘图工具后自动刷新右侧栏；用户框选区域点 **📎 `Attach Selection`** 直接附到下一条消息。 |
| **双端同步** | 共享 `${PLUGIN_DATA}/boards/` + 版本号 `rev` 轻量轮询（1.5s） | 无论在对话里让 AI 画，还是在左侧栏手动拖改，两边画布自动保持一致（带本地未保存编辑防覆盖保护）。 |

---

## 3. 摆脱模板束缚：自由图形积木 + 6 种布局引擎

### 3.1 语义图形积木（Composable Primitives）

AI 绘图时不再受限于单一“分层方框模板”，而是自由组合以下基础原语：

1. **节点（`nodes`）**
   - `id`：可读稳定语义 ID（如 `node_api_gw`、`node_redis`）
   - `label`：主标题（支持 `\n` 换行）
   - `sublabel`（可选）：副标题/技术栈小字（如 `gRPC · 3 replicas`）
   - `shape`：
     - `rounded`（默认圆角矩形：服务、模块、组件）
     - `rect`（直角矩形：边界、子系统、表格块）
     - `diamond`（菱形：条件判断、网关路由、决策节点）
     - `ellipse`（椭圆/胶囊：开始/结束、外部用户、状态节点）
     - `database`（数据库/存储形态：带顶部椭圆或双层视觉标识的存储块）
     - `queue`（队列/消息通道形态：横向胶囊/管道样式）
     - `note`（便签卡片：浅黄/浅暖色注释说明块）
     - `text`（无边框标题/图例/注释文字）
   - `group`（可选）：归属的父容器 `groupId`（支持任意深度嵌套）
   - `tone`（可选）：语义色阶（`blue` / `purple` / `green` / `amber` / `rose` / `teal` / `slate` / `neutral`）
   - `style`（可选）：`roughness`（`0` 规整正式架构风 / `1` 经典手绘风）、`fillStyle`（`solid` / `hachure`）

2. **分组容器（`groups`）**
   - `id`、`label`、`parentGroup`（支持多层嵌套，如 `云VPC -> K8s集群 -> 业务命名空间`）
   - `tone`、`borderStyle`（`dashed` / `solid`）、`layout`（**支持在某个子分组内部覆盖局部布局方向**，例如整体上下分层，但某层内部横向排列！）

3. **连线（`edges`）**
   - `id`（可选，默认 `edge_<from>_to_<to>`）、`from`、`to`、`label`
   - `lineStyle`：`solid`（同步） / `dashed`（异步/事件） / `dotted`（弱依赖）
   - `emphasis`：`normal` / `primary`（加粗高亮主干数据流）
   - `arrows`：`end`（单向） / `both`（双向） / `none`（无箭头关联）
   - `routing`：`orthogonal`（90° 避障折线，默认） / `curved`（平滑曲线） / `straight`（直线）

### 3.2 六种布局策略（`layout`）

AI 通过 `layout` 参数根据图的本质选择最合适的空间结构，所有计算均在 Node.js 服务端完成：

| `layout` 值 | 底层算法 | 适用图类型 | 视觉效果特点 |
| :--- | :--- | :--- | :--- |
| `layered-tb` | `ELK layered (DOWN)` | 系统分层架构图、部署图、调用层级图 | 清晰上下分层、嵌套分组框自动撑开、正交避障走线 |
| `layered-lr` | `ELK layered (RIGHT)` | **数据流向图 (DFD)**、ETL/CI 管道、处理链路 | 强烈横向流动感，配合粗高亮主干线与分支菱形 |
| `box` | `ELK rectpacking / box` | **功能模块图**、能力全景蓝图、系统架构拼图 | 紧凑嵌套大块矩阵，大模块包小模块，极具“白皮书全景图”质感 |
| `stress` | `ELK stress` | 微服务网状拓扑、多对多模块依赖关系图 | 按连接密度自然聚类，打破僵硬行列感 |
| `mrtree` | `ELK mrtree` | 模块拆解树、目录/组件继承树、思维导图 | 清晰的父子树状展开，零交叉 |
| `sequence` | 专用轻量时序排版器 | 请求交互时序图、协议握手流程 | 顶部参与者 + 竖向虚线生命线 + 按顺序自上而下的横向消息箭头 |
| `free` | AI 指定相对方位/区域 + 碰撞修正求解器 | 左右对比图、四象限、环形图、创意草图 | 不受图算法拘束，服务端自动测宽 + 推开重叠框 |

### 3.3 多区域画布（Multi-Zone Canvas）
`draw_diagram` 支持 `placement` 参数：
- `replace`：清空当前画布并重画；
- `append-right` / `append-below`：保留画布已有内容，在现有内容右侧或下方留出安全间距（如 `120px`）追加一张新子图（例如同一块无限画布，左边画**功能模块全景图**，右边画**核心数据流向图**）。

---

## 4. 防重叠与空间感知核心引擎

为了杜绝“字撑破框、框压框、线穿框、线粘连”，服务端内置 5 步流水线：

1. **步骤 1：中英文混合精确测宽与自动换行**
   - 区分 CJK 全角字符（约 `1.0 × fontSize`）与 ASCII 字符（约 `0.58 × fontSize`），对过长标签按最大行宽（如 `220px`）智能断行；
   - 结合 `sublabel` 行高和固定安全内边距（`paddingX = 24px`, `paddingY = 16px`），在布局前得出每个节点的真实 `(width, height)`。
2. **步骤 2：`ELK.js` 复合嵌套布局约束**
   - 配置硬性间距参数：
     - `elk.spacing.nodeNode`: `48`（同层节点最小间隔）
     - `elk.layered.spacing.nodeNodeBetweenLayers`: `76`（层间最小间隔，给连线和标签留足通道）
     - `elk.spacing.edgeEdge`: `18`（平行连线之间强制留缝，绝不叠成一根线）
     - `elk.spacing.edgeNode`: `24`（连线与无关节点保持安全距离）
     - `elk.padding`: `[top=44, left=24, bottom=24, right=24]`（分组框顶部为标题留足专属空间）
   - 启用 `elk.hierarchyHandling: "INCLUDE_CHILDREN"`，使跨分组连线也参与全局避障计算。
3. **步骤 3：正交避障走线与端口分散**
   - `elk.edgeRouting: "ORTHOGONAL"` 产出每条边的精确 `startPoint`、`bendPoints[]`、`endPoint`；
   - 多条边出入同一节点时，由 ELK 自动错开锚点位置；
   - 边标签（edge label）由 ELK 计算独立位置坐标，避免压在节点或其他连线上。
4. **步骤 4：原生 Excalidraw 编译器（保留交互绑定）**
   - 容器框放底层，节点放中层，绑定的文本（`containerId`）随节点居中，箭头放顶层；
   - 每条箭头写入 `startBinding` / `endBinding`（指向源/目标节点 `id`）并在源/目标节点同步写入 `boundElements`，保证用户在 Excalidraw 中拖动任意节点时，箭头自动重连跟随；
   - 在每个元素的 `customData` 中记录轻量元数据（`{ semanticId, role, groupId, layoutZone }`），用于后续精确语义摘要与局部修改。
5. **步骤 5：后置碰撞检测与兜底求解（针对 `free` 模式与增量修改）**
   - 对非嵌套的同级元素做 AABB 包围盒检测，如存在交叠（`overlap > 0`），沿最小位移轴（Minimum Translation Vector）自动推开并保持 `24px` 安全边距，同时更新绑定箭头端点。

---

## 5. 手术级局部框选修改协议（Precision Local Editing）

### 5.1 前端框选提取（用户侧）
用户在 Excalidraw 中用鼠标框选任意元素后，顶部工具栏动态显示选中数量与操作按钮：
- 右侧栏（`aux_pane`）：**📎 `Attach (N selected)`** / **✨ `Ask AI`**
- 左侧栏（`global`）：**📋 `Copy Selection Context`**

点击后，前端通过 `excalidrawAPI.getSceneElements()` 和 `appState.selectedElementIds` 自动提取结构化局部上下文：

```json
{
  "boardId": "board_20261124_arch",
  "boardTitle": "Order System Architecture",
  "selectionBox": { "x": 420, "y": 260, "width": 380, "height": 240 },
  "selectedElements": [
    { "id": "node_order_svc", "type": "rounded", "label": "Order Service", "group": "group_core", "bounds": [440, 300, 160, 64] },
    { "id": "node_pay_svc", "type": "rounded", "label": "Payment Service", "group": "group_core", "bounds": [620, 300, 160, 64] },
    { "id": "edge_order_to_pay", "type": "arrow", "from": "node_order_svc", "to": "node_pay_svc", "label": "Sync HTTP" }
  ],
  "externalBoundaryEdges": [
    {
      "edgeId": "edge_gw_to_order",
      "direction": "incoming",
      "externalNode": { "id": "node_gateway", "label": "API Gateway", "bounds": [440, 110, 180, 60] },
      "selectedNodeId": "node_order_svc",
      "label": "gRPC"
    },
    {
      "edgeId": "edge_order_to_pg",
      "direction": "outgoing",
      "selectedNodeId": "node_order_svc",
      "externalNode": { "id": "node_pg", "label": "PostgreSQL", "bounds": [440, 560, 160, 64] },
      "label": "SQL"
    }
  ],
  "nearbyObstacles": [
    { "id": "node_auth_svc", "label": "Auth Service", "side": "left", "bounds": [180, 300, 160, 64] }
  ],
  "snapshotPath": "C:/Users/.../plugin_data/antigravity-whiteboard/snapshots/sel_173246.png"
}
```

> **双通道视觉+结构定位**：
> - `selectedElements` + `externalBoundaryEdges` 给 AI 100% 精确的 ID、拓扑关系和边界接口；
> - `snapshotPath` 由前端调用 `exportToBlob` 将选中区（含四周 `80px` 周边上下文留白）导出为 PNG 并经 `app_save_selection_snapshot` 落盘，当用户说“这块太挤/不好看/理顺点”时，AI 可直接用 `read_file` 亲眼查看局部视觉效果后再精准下刀。

### 5.2 服务端局部替换与外围保护（`replace_region`）
当 AI 调用 `replace_region` 时，传入：
- `boardId`
- `targetIds`：本次要替换的选中元素 ID 列表（仅这些元素会被移除替换，**其余所有元素锁定不动**）
- `replacement`：新局部的声明式结构（`layout`、`groups`、`nodes`、`edges`）
- `rebindExternalEdges`：外部边界连线的重新映射规则（例如把原本连到 `node_order_svc` 的外部边 `edge_gw_to_order` 重连到新生成的 `node_order_api`）

服务端执行流程：
1. **自动备份历史版本**（写入内存/磁盘 undo 栈，支持一键回滚）；
2. **锁定外部元素**：过滤掉 `targetIds` 及其专属内部绑定元素，保留画布其余全部元素坐标不动；
3. **局部排版**：对 `replacement` 运行选定的布局算法（`ELK.js` / `sequence` / `free`），将其中心/左上角精准锚定到原 `selectionBox`；
4. **碰撞保护**：检测新局部包围盒是否与 `nearbyObstacles` 冲突：
   - 若新局部放得下原位置，直接落位；
   - 若略微超出，仅将紧邻冲突方向的外部同层元素平滑外推最小安全距离（或由服务端报告提示），**绝不覆盖压住外部图形**；
5. **外部连线重接**：根据 `rebindExternalEdges` 重算外部节点到新入口/出口节点的正交避障路径并重建绑定；
6. **递增画布版本号 `rev`**：前端轮询检测到 `rev` 变化后，平滑刷新画布并短暂高亮刚更新的局部区域（不重置用户当前缩放/视口位置）。

---

## 6. MCP 工具与资源接口设计

### 6.1 UI 资源
- URI：`ui://antigravity-whiteboard/app.html`
- MIME：`text/html;profile=mcp-app`
- 体积预算：单文件自包含 HTML，目标控制在 **3.5–5.5 MiB**（严格低于 10 MiB 上限），所有字体内联或使用本地安全字体，零外部 CDN 依赖（完全符合默认 CSP `default-src 'none'`）。

### 6.2 模型可见工具（AI-Facing Tools）

共 6 个精简高表达力工具，严格控制 schema 简洁度与 token 占用：

| 工具名 | 入口 / 用途 | 核心参数 |
| :--- | :--- | :--- |
| `open_whiteboard` | 挂载 `global` + `aux_pane` 入口；打开或切换指定画板 | `boardId?`, `title?` |
| `list_boards` | 列出所有本地画板及基本信息（ID、标题、节点数、更新时间） | `{}` |
| `get_board_summary` | 返回当前画板的**精简空间语义摘要**（分组、节点 ID/label/包围盒、连线关系），绝不吐原始大 JSON | `boardId?` |
| `draw_diagram` | 使用 6 种布局策略生成完整图或追加新区域子图 | `boardId?`, `title?`, `layout`, `placement?`, `groups?`, `nodes`, `edges`, `style?` |
| `replace_region` | **框选局部精确替换**：锁定外部元素、局部重排、重接外部边界连线 | `boardId`, `targetIds`, `replacement`, `rebindExternalEdges?` |
| `patch_elements` | 轻量增量操作：修改指定节点文字/颜色/样式、新增单个便签/节点、删除指定元素 | `boardId`, `add?`, `update?`, `deleteIds?` |
| `import_mermaid` | 快速把已有 Mermaid 流程图/时序图转换为可编辑 Excalidraw 元素 | `boardId?`, `mermaid`, `placement?` |

### 6.3 App 专属工具（`visibility: ["app"]`，模型不可见）
- `app_list_boards`：获取画板列表
- `app_load_board`：加载完整 `.excalidraw` 场景 JSON 与版本号 `rev`
- `app_save_board`：保存用户手动编辑后的场景（带乐观锁 `baseRev` 避免覆盖 AI 刚写的更新）
- `app_create_board` / `app_rename_board` / `app_delete_board` / `app_undo_board`
- `app_poll_board`：极轻接口，只返回 `{ boardId, rev, updatedAt }` 供双栏 1.5s 同步
- `app_save_selection_snapshot`：接收前端导出的选中区域 base64 PNG 并写入 `${PLUGIN_DATA}/snapshots/`，返回绝对路径
- `app_export_to_workspace`：一键将当前画板保存为当前工作区里的 `.excalidraw` / `.svg` / `.png` 文件

---

## 7. 内置插件 Skill（`skills/diagram-design/SKILL.md`）

随插件一起分发一份面向 Antigravity 的绘图决策 Skill，让 AI 自然画出高质量、不千篇一律的图：
1. **按意图选构图**：
   - 数据流 / 请求链路 / Pipeline → `layered-lr`（主干加粗 + 分支菱形）
   - 分层架构 / 系统部署 → `layered-tb`（嵌套分组 + 正交走线）
   - 功能模块全景 / 能力矩阵 → `box`（多层嵌套拼图）
   - 复杂服务网状依赖 → `stress`；代码/组件树 → `mrtree`
   - 交互时序 → `sequence`；方案对比/四象限 → `free`
2. **信息密度与可读性准则**：单节点文字精炼（标题 + 短副标题），合理使用颜色语义区分角色（接入/计算/存储/外部），用虚实线区分同步/异步。
3. **局部修改规范**：收到框选上下文时优先使用 `replace_region` 或 `patch_elements`，严格保持未选中区域不变，并在重排后检查外部边界连线是否全部重接。

---

## 8. 单文件打包、CSP 与 Excalidraw 工程注意点

Excalidraw 在 MCP App 的隔离 iframe + 默认 CSP 下有 3 个必须提前规避的工程坑：

1. **禁止运行时请求外网 CDN（字体 / 资源）**
   - Excalidraw 默认会向 `unpkg.com` / `esm.sh` 请求字体文件（Virgil / Excalifont），在默认 CSP `default-src 'none'` 下会被拦截导致手绘字体失效或控制台报错。
   - **解法**：构建时将 Excalidraw 资源路径指向本地内联字体（或配置 `window.EXCALIDRAW_ASSET_PATH = "./"` 并将精简字体以 `data:font/woff2;base64,...` 内联进 CSS），确保 100% 离线、零外链请求。
2. **体积控制在 10 MiB 以内**
   - `ELK.js` 跑在 **Node.js 服务端**（完全不进入前端 HTML）；
   - 前端仅打包 React + Excalidraw 核心 + `@modelcontextprotocol/ext-apps` + 精简图标，预估单文件 HTML 约 3–5 MiB，远低于 10 MiB 上限。
3. **并发上限（≤ 4 in-flight）与状态持久化**
   - 前端所有 `callServerTool` 走 3 并发队列，手动编辑采用 `600ms` 防抖自动保存到服务端（MCP App 无持久化 `localStorage` 且关闭不触发 teardown，因此必须实时落盘）。

---

## 9. 目录结构规划

```text
antigravity-whiteboard/
├── DESIGN.md
├── README.md
├── LICENSE
├── plugin.json
├── mcp_config.json
├── assets/
│   └── logo.svg
├── skills/
│   └── diagram-design/
│       └── SKILL.md               # 内置 AI 绘图与局部修改指南
├── scripts/
│   ├── build-ui.mjs               # 单文件 HTML 打包（含字体离线内联检查）
│   ├── build-server.mjs           # esbuild 打包服务端（含 elkjs）
│   └── install-plugin.mjs         # 一键安装到 ~/.gemini/config/plugins/antigravity-whiteboard
├── src/
│   ├── shared/
│   │   └── dsl.ts                 # 声明式绘图 DSL、布局策略与选区上下文共享类型
│   ├── server/
│   │   ├── index.ts               # MCP Server (stdio) + 工具与资源注册
│   │   ├── storage.ts             # 多画板存储、版本乐观锁、Undo 历史与工作区导出
│   │   ├── text-metrics.ts        # CJK/Latin 文本测宽与智能换行
│   │   ├── layout-engine.ts       # ELK.js 多布局引擎 + 时序排版器 + 碰撞求解器
│   │   ├── excalidraw-compiler.ts # 布局结果 -> 原生绑定 Excalidraw 元素编译器
│   │   ├── region-editor.ts       # 局部框选替换、外部连线重接与碰撞保护
│   │   └── mermaid-importer.ts    # Mermaid -> Excalidraw 转换器
│   └── ui/
│       ├── main.tsx
│       ├── App.tsx                # MCP App 宿主桥接、双栏同步、顶栏与画板切换
│       ├── styles.css
│       └── selection-context.ts   # 选中元素 + 外部邻居边界提取 + PNG 快照导出
└── dist/
    ├── server.mjs
    └── index.html
```

---

## 10. 实施里程碑

- **Phase 1 — 核心骨架与离线 Excalidraw 跑通**：搭建插件结构、多画板存储、Excalidraw 离线单文件构建（验证体积 < 10 MiB、零外链 CSP 错误、浅色/深色主题同步、双栏同步）。
- **Phase 2 — 多布局防重叠引擎**：落地 `text-metrics` + `ELK.js`（`layered-tb` / `layered-lr` / `box` / `stress` / `mrtree`）+ `sequence` + `free` 碰撞求解器 + 原生 Excalidraw 绑定编译器 + `import_mermaid`。
- **Phase 3 — 手术级框选局部修改**：落地前端框选上下文提取（语义 ID + 外部边界连线 + 局部 PNG 快照）与服务端 `replace_region` / `patch_elements` + 一键回滚。
- **Phase 4 — Skill、工作区导出与验证发布**：编写内置 `diagram-design` Skill、一键导出到当前 Antigravity 工作区、MCP 协议与布局防重叠自动化测试、安装到本地并推送开源。
