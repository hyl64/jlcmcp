#!/usr/bin/env node
/**
 * smoke-bridge.mjs — 无真实 EDA 的端到端协议验证
 *
 * 启动官方 Bridge Server → 以 mock EDA 客户端连接（handshake/register）→
 * 对全部经典动作执行 actionToCode 生成的代码 → POST /execute 验证结果。
 *
 * 用法：npm run build && npm run test:bridge
 */
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { BridgeClient } from '../dist/bridge-client.js';

const ROOT = process.cwd();

// ─── 1. 启动/连接 Bridge Server ──────────────────────────────────────
async function ensureBridge() {
  for (let port = 49620; port <= 49629; port++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(300) });
      const j = await res.json();
      if (j.service === 'easyeda-bridge') return port;
    } catch { /* next */ }
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/bridge-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (d) => process.stderr.write('[bridge] ' + d));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    for (let port = 49620; port <= 49629; port++) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(200) });
        const j = await res.json();
        if (j.service === 'easyeda-bridge') return port;
      } catch { /* next */ }
    }
  }
  throw new Error('Bridge server did not start');
}

// ─── 2. Mock EDA 客户端 ─────────────────────────────────────────────
function compRow(designator) {
  return {
    getState_PrimitiveId: () => 'prim-' + designator,
    getState_Designator: () => designator,
    getState_Name: () => 'R-10k',
    getState_X: () => 1000,
    getState_Y: () => 2000,
    getState_Rotation: () => 0,
    getState_Width: () => 100,
    getState_Height: () => 50,
    getState_Layer: () => 1,
    getState_PrimitiveLock: () => false,
    getState_Pads: () => [{ net: 'GND' }, { net: 'VCC' }],
  };
}

const fakeEda = {
  pcb_PrimitiveComponent: {
    getAll: async () => [compRow('U1'), compRow('R1')],
    modify: async (id, props) => { (fakeEda.__modifyLog ||= []).push({ id, props }); },
    create: async (c, layer, x, y, rotation, lock) => compRow('NEW1'),
  },
  pcb_Net: {
    getAllNetsName: async () => ['GND', 'VCC', 'SDA'],
    getNetLength: async (n) => (n === 'GND' ? 123.4 : 56.7),
  },
  pcb_PrimitiveLine: {
    getAll: async (net, layer) => [{
      getState_PrimitiveId: () => 't1',
      getState_Net: () => net || 'GND',
      getState_Layer: () => layer ?? 1,
      getState_StartX: () => 0, getState_StartY: () => 0,
      getState_EndX: () => 100, getState_EndY: () => 100,
      getState_Width: () => 10,
    }],
    create: async () => true,
    delete: async () => true,
  },
  pcb_PrimitivePad: {
    getAll: async () => [
      { getState_PrimitiveId: () => 'pad1', getState_Net: () => 'GND', getState_X: () => 10, getState_Y: () => 20, getState_Designator: () => 'U1', getState_PrimitiveLock: () => false, getState_Diameter: () => 30, getState_Shape: () => 'round' },
      { getState_PrimitiveId: () => 'pad2', getState_Net: () => 'VCC', getState_X: () => 100, getState_Y: () => 200, getState_Designator: () => 'U1', getState_PrimitiveLock: () => false, getState_Diameter: () => 30, getState_Shape: () => 'round' },
      { getState_PrimitiveId: () => 'pad3', getState_Net: () => 'VCC', getState_X: () => 500, getState_Y: () => 600, getState_Designator: () => 'R1', getState_PrimitiveLock: () => false, getState_Diameter: () => 30, getState_Shape: () => 'round' },
      { getState_PrimitiveId: () => 'pad4', getState_Net: () => 'SDA', getState_X: () => 900, getState_Y: () => 300, getState_Designator: () => 'R1', getState_PrimitiveLock: () => false, getState_Diameter: () => 30, getState_Shape: () => 'round' },
      { getState_PrimitiveId: () => 'pad5', getState_Net: () => 'SDA', getState_X: () => 1200, getState_Y: () => 700, getState_Designator: () => 'U1', getState_PrimitiveLock: () => false, getState_Diameter: () => 30, getState_Shape: () => 'round' },
    ],
  },
  pcb_PrimitiveVia: {
    getAll: async () => [],
    create: async (net, x, y, hole, dia) => ({ getState_PrimitiveId: () => 'via-new' }),
    delete: async () => true,
  },
  pcb_PrimitiveString: {
    getAll: async () => [],
    modify: async () => true,
  },
  pcb_Primitive: {
    getPrimitivesBBox: async () => ({ minX: 0, minY: 0, maxX: 100, maxY: 100 }),
  },
  pcb_MathPolygon: {
    createPolygon: async (s) => s,
    createComplexPolygon: async (s) => s,
  },
  pcb_PrimitiveRegion: {
    create: async () => ({ getState_PrimitiveId: () => 'region-1' }),
    delete: async () => true,
  },
  pcb_PrimitivePour: {
    create: async () => ({ getState_PrimitiveId: () => 'pour-1' }),
    delete: async () => true,
  },
  pcb_Drc: {
    check: async () => [],
    runDrc: async () => [],
    createDifferentialPair: async () => true,
    deleteDifferentialPair: async () => true,
    getAllDifferentialPairs: async () => [{ name: 'USB', positiveNet: 'USB_DP', negativeNet: 'USB_DN' }],
    createEqualLengthNetGroup: async () => true,
    deleteEqualLengthNetGroup: async () => true,
    getAllEqualLengthNetGroups: async () => [{ name: 'DATA', nets: ['D0', 'D1'] }],
  },
  dmt_Board: {
    getCurrentBoardInfo: async () => ({ name: 'TEST', pcbUuid: 'pcb-u1', schematicUuid: 'sch-u1' }),
  },
  dmt_EditorControl: {
    openDocument: async (uuid) => 'tab-' + uuid,
    activateDocument: async () => true,
    zoomToAllPrimitives: async () => true,
    getCurrentRenderedAreaImage: async () => undefined,
  },
  dmt_SelectControl: {
    getCurrentDocumentInfo: async () => undefined,
  },
  pcb_Document: {
    exportImage: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  },
  pcb_SelectControl: {
    selectByDesignator: async () => true,
    deleteSelected: async () => true,
    getAllSelectedPrimitives_PrimitiveId: async () => [],
  },
  sch_PrimitiveComponent: { getAll: async () => [] },
  sch_PrimitivePin: { getAll: async () => [] },
  sch_PrimitiveWire: { getAll: async () => [] },
  sch_Netlist: { getNetlist: async () => '(mock netlist)' },
  sch_Drc: { check: async () => true },
  sys_Canvas: { toDataURL: async () => undefined },
};

async function connectMockEda(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/eda');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'handshake') {
      ws.send(JSON.stringify({ type: 'register', windowId: 'mock-win-1', timestamp: Date.now() }));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', id: msg.id, timestamp: Date.now() }));
    } else if (msg.type === 'execute') {
      try {
        const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
        const fn = new AsyncFunction('eda', msg.code);
        const result = await fn(fakeEda);
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result: result !== undefined ? result : null, timestamp: Date.now() }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', id: msg.id, error: err.message, timestamp: Date.now() }));
      }
    }
  });
  return ws;
}

// ─── 3. 执行测试 ─────────────────────────────────────────────────────
const port = await ensureBridge();
console.log('✔ Bridge Server @', port);
const mockWs = await connectMockEda(port);
await new Promise((r) => setTimeout(r, 300));
const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
console.log('✔ health.edaConnected =', health.edaConnected, '| windows =', health.edaWindowCount);

// 从 dist 导入 codegen（需先 npm run build）
const codegen = await import(pathToFileURL(path.join(ROOT, 'dist/codegen.js')).href);
const { actionToCode, SUPPORTED_ACTIONS } = codegen;
console.log('✔ actions from codegen:', SUPPORTED_ACTIONS.length);

async function execAction(action, params = {}) {
  const code = actionToCode(action, params);
  const res = await fetch('http://127.0.0.1:' + port + '/execute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(action + ' → ' + body.error);
  return body.result;
}

const results = [];
const cases = [
  ['ping', {}],
  ['get_state', {}],
  ['get_feature_support', {}],
  ['get_board_info', {}],
  ['get_tracks', {}],
  ['get_pads', {}],
  ['get_net_primitives', { net: 'GND' }],
  ['get_silkscreens', {}],
  ['move_component', { designator: 'U1', x: 1500, y: 2500, rotation: 90 }],
  ['relocate_component', { designator: 'R1', x: 800, y: 900 }],
  ['select_component', { designator: 'U1' }],
  ['delete_selected', {}],
  ['create_via', { net: 'GND', x: 500, y: 600, holeDiameter: 10 }],
  ['delete_via', { primitiveId: 'v1' }],
  ['delete_tracks', { primitiveId: 't1' }],
  ['route_track', { net: 'GND', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], layer: 1, width: 10 }],
  ['create_keepout_rect', { x1: 0, y1: 0, x2: 100, y2: 100 }],
  ['delete_region', { primitiveId: 'r1' }],
  ['create_pour_rect', { net: 'GND', x1: 0, y1: 0, x2: 200, y2: 200, layer: 1 }],
  ['delete_pour', { primitiveId: 'p1' }],
  ['create_differential_pair', { name: 'USB', positiveNet: 'USB_DP', negativeNet: 'USB_DN' }],
  ['list_differential_pairs', {}],
  ['delete_differential_pair', { name: 'USB' }],
  ['create_equal_length_group', { name: 'DATA', nets: ['D0', 'D1'] }],
  ['list_equal_length_groups', {}],
  ['delete_equal_length_group', { name: 'DATA' }],
  ['run_drc', {}],
  ['get_schematic_state', {}],
  ['get_netlist', {}],
  ['run_sch_drc', {}],
  ['open_document', { uuid: 'sch-u1' }],
  ['create_pcb_component', { component: { libraryUuid: 'lib-1', uuid: 'cmp-1' }, layer: 1, x: 100, y: 100 }],
  ['auto_silkscreen', {}],
  ['move_silkscreen', { primitiveId: 'silk-1', x: 1, y: 2 }],
  ['screenshot', {}],
];

let pass = 0, fail = 0;
for (const [action, params] of cases) {
  try {
    const data = await execAction(action, params);
    const preview = typeof data === 'object' && data !== null ? JSON.stringify(data).slice(0, 90) : String(data);
    console.log('  ✔ ' + action.padEnd(28) + ' → ' + preview);
    pass++;
  } catch (e) {
    console.log('  ✗ ' + action.padEnd(28) + ' → ' + e.message.slice(0, 160));
    fail++;
  }
}

// 校验关键数据
const state = await execAction('get_state');
const assert = (cond, msg) => { if (!cond) { console.log('✗ ASSERT FAIL: ' + msg); fail++; } else { console.log('  ✔ assert: ' + msg); pass++; } };
assert(state.components?.length === 2, 'get_state returns 2 components');
assert(state.nets?.length === 3, 'get_state returns 3 nets');
const moveCall = (fakeEda.__modifyLog || []).find((m) => m.id === 'prim-U1');
assert(moveCall?.props?.x === 1500, 'move_component modified x=1500');
assert(moveCall?.props?.rotation === 90, 'move_component modified rotation=90');


// ─── 4. 高级功能测试（真实 BridgeClient 走官方协议）─────────────────
const pro = await import(pathToFileURL(path.join(ROOT, 'dist/tools/pro.js')).href);
const realBridge = new BridgeClient({ baseUrl: 'http://127.0.0.1:' + port });

const bom = await pro.exportBom(realBridge);
assert(bom.itemCount === 1, 'BOM: 1 类元件（R-10k x2）');
assert(bom.items[0].quantity === 2, 'BOM: R-10k 数量 2');

const conn = await pro.checkConnectivity(realBridge);
assert(conn.totalNets === 3, 'connectivity: 3 个网络');
assert(conn.nets.find((n) => n.net === 'VCC')?.padCount === 2, 'connectivity: VCC 有 2 个焊盘');

const dens = await pro.currentDensityReport(realBridge);
assert(dens.report.find((n) => n.net === 'GND')?.trackCount === 1, 'density: GND 有 1 条走线');

const fan = await pro.fanoutComponent(realBridge, { designator: 'U1' });
assert(fan.padCount === 3, 'fanout: U1 有 3 个焊盘');
assert(fan.fanoutCreated === 3, 'fanout: 创建 3 个过孔');

const route = await pro.autoRouteNets(realBridge, { nets: ['VCC', 'SDA'] });
assert(route.routedNets === 2, 'auto_route: 布线 2 个网络');
assert(route.totalTrackSegments >= 2, 'auto_route: 生成走线段');

const fix = await pro.drcAutoFix(realBridge);
assert(fix.after.passed === true, 'drc_autofix: DRC 通过');

mockWs.close();
console.log('\n==== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ====');
process.exit(fail > 0 ? 1 : 0);
