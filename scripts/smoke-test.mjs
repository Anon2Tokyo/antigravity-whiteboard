import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wb-test-'));
const proc = spawn('node', ['--no-warnings', 'dist/server.mjs', `--data-dir=${tmpDataDir}`], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let nextId = 1;
const pending = new Map();

proc.stderr.on('data', (d) => {
  process.stderr.write(`[server stderr] ${d.toString()}`);
});

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout on ${method}`)), 10000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method} error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function callTool(name, args = {}) {
  return rpc('tools/call', { name, arguments: args }).then((res) => {
    assert.ok(!res.isError, `Tool ${name} returned error: ${JSON.stringify(res.content)}`);
    return res.structuredContent;
  });
}

function assertNoNodeOverlaps(elements, label) {
  const nodeRects = elements
    .filter((e) => !e.isDeleted && e.customData?.role === 'node')
    .map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height }));
  const nodeMap = new Map(nodeRects.map((n) => [n.id, n]));

  for (let i = 0; i < nodeRects.length; i++) {
    for (let j = i + 1; j < nodeRects.length; j++) {
      const a = nodeRects[i];
      const b = nodeRects[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(
        !(overlapX > 0.5 && overlapY > 0.5),
        `[${label}] Overlap detected between ${a.id} (${a.x},${a.y},${a.w}x${a.h}) and ${b.id} (${b.x},${b.y},${b.w}x${b.h})`,
      );
    }
  }

  // Verify every non-sequence arrow's start & end points actually touch their source & target nodes
  if (label !== 'sequence') {
    const arrows = elements.filter((e) => !e.isDeleted && e.type === 'arrow');
    for (const arr of arrows) {
      const fromId = arr.startBinding?.elementId;
      const toId = arr.endBinding?.elementId;
      if (!fromId || !toId || !Array.isArray(arr.points) || arr.points.length < 2) continue;
      const fromNode = nodeMap.get(fromId);
      const toNode = nodeMap.get(toId);
      if (!fromNode || !toNode) continue;

      const pStart = { x: arr.x + arr.points[0][0], y: arr.y + arr.points[0][1] };
      const last = arr.points[arr.points.length - 1];
      const pEnd = { x: arr.x + last[0], y: arr.y + last[1] };

      const distToRect = (p, r) => {
        const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
        const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
        return Math.hypot(dx, dy);
      };

      const dStart = distToRect(pStart, fromNode);
      const dEnd = distToRect(pEnd, toNode);
      assert.ok(dStart <= 12, `[${label}] Arrow ${arr.id} start (${pStart.x},${pStart.y}) is ${dStart.toFixed(1)}px away from ${fromId}`);
      assert.ok(dEnd <= 12, `[${label}] Arrow ${arr.id} end (${pEnd.x},${pEnd.y}) is ${dEnd.toFixed(1)}px away from ${toId}`);
    }
  }
}

try {
  // 1. Handshake & metadata verification
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0' },
  });
  assert.equal(init.serverInfo.name, 'antigravity-whiteboard');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const tools = await rpc('tools/list');
  const withEntrypoints = tools.tools.filter((t) => t._meta?.['com.google.antigravity/ui']?.entrypoints);
  assert.equal(withEntrypoints.length, 1, 'Exactly one tool should declare sidebar entrypoints');
  assert.equal(withEntrypoints[0].name, 'open_whiteboard');
  const epTypes = withEntrypoints[0]._meta['com.google.antigravity/ui'].entrypoints.map((e) => e.type);
  assert.deepEqual(epTypes.sort(), ['aux_pane', 'global']);

  const resRead = await rpc('resources/read', { uri: 'ui://antigravity-whiteboard/app.html' });
  const html = resRead.contents[0].text;
  assert.equal(resRead.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(Buffer.byteLength(html, 'utf8') < 10 * 1024 * 1024, 'HTML must be under 10 MiB');
  console.log(`PASS: MCP handshake, entrypoints, and UI resource (${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)} MiB)`);

  // 2. Test all 7 layout strategies + assert zero node overlaps
  const strategies = ['layered-tb', 'layered-lr', 'box', 'stress', 'mrtree', 'sequence', 'free'];
  for (const layout of strategies) {
    const boardId = `test_${layout}`;
    const drawRes = await callTool('draw_diagram', {
      boardId,
      title: `Test ${layout}`,
      layout,
      groups:
        layout === 'sequence' || layout === 'stress' || layout === 'mrtree'
          ? undefined
          : [
              { id: 'grp_edge', label: '接入层 Edge', tone: 'blue' },
              { id: 'grp_core', label: '核心服务 Core', tone: 'purple' },
            ],
      nodes: [
        { id: 'n_client', label: 'Web Client', sublabel: 'React', shape: 'ellipse', group: layout === 'sequence' || layout === 'stress' || layout === 'mrtree' ? undefined : 'grp_edge' },
        { id: 'n_gw', label: 'API Gateway', sublabel: 'Nginx / Envoy', shape: 'diamond', group: layout === 'sequence' || layout === 'stress' || layout === 'mrtree' ? undefined : 'grp_edge' },
        { id: 'n_order', label: '订单服务 Order', sublabel: 'Go · gRPC', shape: 'rounded', group: layout === 'sequence' || layout === 'stress' || layout === 'mrtree' ? undefined : 'grp_core' },
        { id: 'n_db', label: 'PostgreSQL', sublabel: 'Primary', shape: 'database', group: layout === 'sequence' || layout === 'stress' || layout === 'mrtree' ? undefined : 'grp_core' },
      ],
      edges: [
        { from: 'n_client', to: 'n_gw', label: 'HTTPS', emphasis: 'primary' },
        { from: 'n_gw', to: 'n_order', label: 'gRPC' },
        { from: 'n_order', to: 'n_db', label: 'SQL', lineStyle: 'dashed' },
      ],
    });
    assert.equal(drawRes.nodeCount, 4);
    const loaded = await callTool('app_load_board', { boardId });
    assertNoNodeOverlaps(loaded.board.scene.elements, layout);
    console.log(`PASS: layout=${layout} (0 overlaps, ${loaded.board.meta.elementCount} elements)`);
  }

  // 3. Test multi-zone append-right (zero overlap with first zone)
  await callTool('draw_diagram', {
    boardId: 'test_layered-tb',
    layout: 'layered-lr',
    placement: 'append-right',
    nodes: [
      { id: 'z2_in', label: 'Event Stream' },
      { id: 'z2_out', label: 'Analytics Sink', shape: 'database' },
    ],
    edges: [{ from: 'z2_in', to: 'z2_out', label: 'Async' }],
  });
  const multiZone = await callTool('app_load_board', { boardId: 'test_layered-tb' });
  assertNoNodeOverlaps(multiZone.board.scene.elements, 'append-right');
  console.log('PASS: multi-zone append-right (0 overlaps across zones)');

  // 4. Test precision box-selection replace_region + external edge rebinding
  await callTool('draw_diagram', {
    boardId: 'test_region',
    title: 'Region Edit Test',
    layout: 'layered-lr',
    nodes: [
      { id: 'node_gw', label: 'Gateway' },
      { id: 'node_order', label: 'Order Service' },
      { id: 'node_pg', label: 'PostgreSQL', shape: 'database' },
    ],
    edges: [
      { id: 'edge_gw_order', from: 'node_gw', to: 'node_order', label: 'HTTP' },
      { id: 'edge_order_pg', from: 'node_order', to: 'node_pg', label: 'SQL' },
    ],
  });
  const before = await callTool('app_load_board', { boardId: 'test_region' });
  const gwBefore = before.board.scene.elements.find((e) => e.id === 'node_gw');
  const pgBefore = before.board.scene.elements.find((e) => e.id === 'node_pg');

  const regRes = await callTool('replace_region', {
    boardId: 'test_region',
    targetIds: ['node_order'],
    replacement: {
      layout: 'layered-lr',
      nodes: [
        { id: 'node_mq', label: 'Kafka Queue', shape: 'queue' },
        { id: 'node_worker', label: 'Order Worker', shape: 'rounded' },
      ],
      edges: [{ from: 'node_mq', to: 'node_worker', label: 'Consume', lineStyle: 'dashed' }],
    },
    rebindExternalEdges: [
      { edgeId: 'edge_gw_order', end: 'end', newNodeId: 'node_mq', label: 'Publish' },
      { edgeId: 'edge_order_pg', end: 'start', newNodeId: 'node_worker' },
    ],
  });
  assert.equal(regRes.reboundEdges, 2);

  const after = await callTool('app_load_board', { boardId: 'test_region' });
  const afterEls = after.board.scene.elements;
  const gwAfter = afterEls.find((e) => e.id === 'node_gw');
  const pgAfter = afterEls.find((e) => e.id === 'node_pg');
  assert.equal(gwAfter.x, gwBefore.x, 'Locked external node_gw must not move');
  assert.equal(pgAfter.x, pgBefore.x, 'Locked external node_pg must not move');
  assert.equal(afterEls.find((e) => e.id === 'node_order'), undefined, 'Replaced node_order should be removed');
  assert.equal(afterEls.find((e) => e.id === 'edge_gw_order').endBinding.elementId, 'node_mq');
  assert.equal(afterEls.find((e) => e.id === 'edge_order_pg').startBinding.elementId, 'node_worker');
  assertNoNodeOverlaps(afterEls, 'replace_region');
  console.log('PASS: replace_region locked external nodes, rebound 2 external edges, 0 overlaps');

  // 5. Test patch_elements & undo
  await callTool('patch_elements', {
    boardId: 'test_region',
    update: [{ id: 'node_mq', label: 'Kafka Topic', tone: 'amber' }],
    addNodes: [{ id: 'note_1', label: 'Async decouple note', shape: 'note' }],
  });
  const undoRes = await callTool('app_undo_board', { boardId: 'test_region' });
  assert.equal(undoRes.undone, true);
  console.log('PASS: patch_elements and server-side undo');

  // 6. Test import_mermaid (flowchart + sequence)
  const mmFlow = await callTool('import_mermaid', {
    boardId: 'test_mermaid',
    mermaid: `flowchart LR
      subgraph Frontend
        U((User)) --> UI[Web App]
      end
      UI -->|REST| API(Backend API)
      API -.-> DB[(Redis)]`,
  });
  assert.equal(mmFlow.nodeCount, 4);
  const mmSeq = await callTool('import_mermaid', {
    boardId: 'test_mermaid_seq',
    mermaid: `sequenceDiagram
      Client->>Gateway: POST /orders
      Gateway-->>OrderSvc: gRPC CreateOrder`,
  });
  assert.equal(mmSeq.layout, 'sequence');
  console.log('PASS: import_mermaid (flowchart + sequence)');

  console.log('\nALL SMOKE TESTS PASSED!');
} finally {
  proc.kill();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
}
