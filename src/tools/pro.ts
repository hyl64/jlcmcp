/**
 * tools/pro.ts — 高级功能（v1.1）
 *
 * 全部基于官方 Bridge（eda.* API）实现，运行于 MCP Server 进程内，
 * 数据通过 bridge.command / bridge.executeRaw 获取与写回。
 */
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

// ─── 类型 ────────────────────────────────────────────────────────────
interface Comp { designator: string; name: string; x: number; y: number; width: number; height: number; padNets: string[]; }
interface Pad { primitiveId: string; net: string; x: number; y: number; designator: string; diameter?: number; holeDiameter?: number; }
interface Track { primitiveId: string; net: string; layer: number | string; startX: number; startY: number; endX: number; endY: number; width: number; }

// IPC-2221 外层电流容量（A），与 calculators.ts 同一公式
function ipcCurrent(areaMil2: number): number {
  const areaMm2 = areaMil2 * 0.00064516;
  return 0.048 * Math.pow(areaMm2, 0.44) * 1000;
}

// ─── 1. BOM 导出 ─────────────────────────────────────────────────────
export async function exportBom(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const byName = new Map<string, { count: number; designators: string[]; padNets: Set<string> }>();
  for (const c of comps) {
    const key = String(c.name || '(unknown)');
    const row = byName.get(key) || { count: 0, designators: [], padNets: new Set<string>() };
    row.count += 1;
    row.designators.push(c.designator);
    for (const n of c.padNets || []) row.padNets.add(n);
    byName.set(key, row);
  }
  const items = Array.from(byName.entries())
    .map(([name, v]) => ({
      name,
      quantity: v.count,
      designators: v.designators.sort(),
      nets: Array.from(v.padNets).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const csv = [
    'name,quantity,designators,nets',
    ...items.map((i) => [i.name, i.quantity, i.designators.join(' '), i.nets.join(' ')].join(',')),
  ].join('\n');
  return { componentCount: comps.length, itemCount: items.length, items, csv };
}

// ─── 2. 网络连通性检查 ───────────────────────────────────────────────
export async function checkConnectivity(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const netNames: string[] = Array.isArray(state?.nets) ? state.nets.map((n: any) => n.name).filter(Boolean) : [];
  const nets: any[] = [];
  for (const net of netNames) {
    const padResult: any = await bridge.command('get_pads', { nets: net });
    const padCount = Array.isArray(padResult?.pads) ? padResult.pads.length : 0;
    const trackResult: any = await bridge.command('get_tracks', { net });
    const trackCount = Array.isArray(trackResult?.tracks) ? trackResult.tracks.length : 0;
    let status: string;
    if (padCount === 0) status = 'no_pads';
    else if (padCount === 1) status = 'single_pad';
    else if (trackCount === 0) status = 'unrouted';
    else status = 'routed';
    nets.push({ net, padCount, trackCount, status });
  }
  const unrouted = nets.filter((n) => n.status === 'unrouted');
  const single = nets.filter((n) => n.status === 'single_pad');
  return {
    totalNets: nets.length,
    routed: nets.filter((n) => n.status === 'routed').length,
    unrouted: unrouted.length,
    singlePadNets: single.length,
    nets,
    recommendations: [
      unrouted.length > 0 ? '以下网络需布线: ' + unrouted.map((n) => n.net).join(', ') : null,
      single.length > 0 ? '以下网络仅 1 个焊盘（悬空）: ' + single.map((n) => n.net).join(', ') : null,
    ].filter(Boolean),
  };
}

// ─── 3. 载流能力报告 ────────────────────────────────────────────────
export async function currentDensityReport(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const netNames: string[] = Array.isArray(state?.nets) ? state.nets.map((n: any) => n.name).filter(Boolean) : [];
  const report: any[] = [];
  for (const net of netNames) {
    const trackResult: any = await bridge.command('get_tracks', { net });
    const tracks: Track[] = Array.isArray(trackResult?.tracks) ? trackResult.tracks : [];
    const padResult: any = await bridge.command('get_pads', { nets: net });
    const padCount = Array.isArray(padResult?.pads) ? padResult.pads.length : 0;
    let totalWidth = 0; // mil
    for (const t of tracks) totalWidth += Number(t.width ?? 0);
    const areaMil2 = totalWidth * 1; // 1mil 厚度铜箔近似（横截面积 ≈ 线宽 × 铜厚）
    const capacityA = ipcCurrent(areaMil2);
    const warning = padCount > 1 && capacityA < 0.2 ? '载流能力偏低（<200mA），建议加宽/铺铜' : null;
    report.push({ net, padCount, trackCount: tracks.length, totalWidthMil: Math.round(totalWidth), estimatedCurrentA: Number(capacityA.toFixed(3)), warning });
  }
  return { totalNets: report.length, report, notes: '估算基于 IPC-2221 外层走线，铜厚 1oz 假设；总宽度=该网络所有线段宽度之和' };
}

// ─── 4. 元件焊盘扇出 ────────────────────────────────────────────────
export async function fanoutComponent(bridge: BridgeClient, params: { designator: string }): Promise<any> {
  const designator = String(params.designator || '').trim();
  if (!designator) throw new Error('designator is required');
  const padResult: any = await bridge.command('get_pads');
  const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
  const mine = pads.filter((p) => String(p.designator || '') === designator);
  const vias: any[] = [];
  const skipped: string[] = [];
  for (const p of mine) {
    if (!p.net) { skipped.push(p.primitiveId); continue; }
    const via = await bridge.command('create_via', { net: p.net, x: p.x, y: p.y, holeDiameter: 8, diameter: 16 });
    vias.push({ pad: p.primitiveId, net: p.net, x: p.x, y: p.y, viaId: (via as any)?.primitiveId });
  }
  return {
    designator,
    padCount: mine.length,
    fanoutCreated: vias.length,
    skippedNoNet: skipped.length,
    vias,
  };
}

// ─── 5. 基础自动布线（L 型，两层） ──────────────────────────────────
export async function autoRouteNets(bridge: BridgeClient, params: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const allNets: string[] = Array.isArray(state?.nets) ? state.nets.map((n: any) => n.name).filter(Boolean) : [];
  const targets = Array.isArray(params.nets) && params.nets.length > 0 ? params.nets.map(String) : allNets;
  const topLayer = params.topLayer ?? 1;
  const viaLayer = params.viaLayer ?? 2;
  const width = params.width ?? 10;

  const summary: any[] = [];
  let totalTracks = 0;
  let totalVias = 0;
  for (const net of targets) {
    const padResult: any = await bridge.command('get_pads', { nets: net });
    const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
    if (pads.length < 2) { summary.push({ net, pads: pads.length, segments: 0, vias: 0, skipped: '不足 2 个焊盘' }); continue; }
    // 按 x 排序后链式连接：第 i 个焊盘 → 第 i+1 个焊盘
    const ordered = [...pads].sort((a, b) => a.x - b.x || a.y - b.y);
    let segments = 0;
    let vias = 0;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const a = ordered[i];
      const b = ordered[i + 1];
      const midX = Math.round((a.x + b.x) / 2);
      // 顶层水平段 a→(midX,a.y)，底层垂直段 (midX,a.y)→(midX,b.y)→b
      await bridge.command('route_track', { net, points: [{ x: a.x, y: a.y }, { x: midX, y: a.y }], layer: topLayer, width });
      segments += 1;
      await bridge.command('create_via', { net, x: midX, y: a.y, holeDiameter: 8, diameter: 16 });
      vias += 1;
      await bridge.command('route_track', { net, points: [{ x: midX, y: a.y }, { x: midX, y: b.y }, { x: b.x, y: b.y }], layer: viaLayer, width });
      segments += 1;
    }
    totalTracks += segments;
    totalVias += vias;
    summary.push({ net, pads: pads.length, segments, vias });
  }
  return {
    routedNets: summary.length,
    totalTrackSegments: totalTracks,
    totalVias: totalVias,
    note: '基础 L 型两层自动布线（顶层水平 + 底层垂直 + 拐角过孔），未做障碍规避/DRC 校验，适合预布线，请用 pcb_run_drc 复查',
    nets: summary,
  };
}

// ─── 6. DRC 自修复 ───────────────────────────────────────────────────
export async function drcAutoFix(bridge: BridgeClient): Promise<any> {
  const before: any = await bridge.command('run_drc');
  const fixes: string[] = [];
  const issues = Array.isArray(before?.issues) ? before.issues : [];
  const ruleText = issues.map((i: any) => String(i?.rule || '')).join(' ');

  // 丝印重叠 → 自动排列丝印
  if (/silkscreen|丝印|silk/i.test(ruleText) || issues.some((i: any) => /silk/i.test(String(i.rule)))) {
    const silk = await bridge.command('auto_silkscreen');
    fixes.push('auto_silkscreen: 移动 ' + ((silk as any)?.moved ?? 0) + ' 个丝印');
  }

  const after: any = await bridge.command('run_drc');
  const beforeCount = Number(before?.totalCount ?? 0);
  const afterCount = Number(after?.totalCount ?? 0);
  return {
    before: { passed: before?.passed, totalCount: beforeCount, errors: before?.summary?.errors },
    after: { passed: after?.passed, totalCount: afterCount, errors: after?.summary?.errors },
    fixedCount: beforeCount - afterCount,
    fixesApplied: fixes,
    remainingIssues: Array.isArray(after?.issues) ? after.issues.slice(0, 20) : [],
    note: '目前可自动修复项：丝印冲突。其余 DRC 问题请人工处理或用 pcb_execute_code 自定义修复。',
  };
}

// ─── MCP 注册 ────────────────────────────────────────────────────────
export function registerProTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_bom_export', '导出 PCB BOM（按元件名聚合：数量、位号、网络），返回 JSON + CSV', {}, async () => {
    const data = await exportBom(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_net_connectivity_check', '检查所有网络的连通性（焊盘数/走线段数，标记未布线网络）', {
    nets: z.array(z.string()).optional().describe('指定检查的网络（默认全部）'),
  }, async ({ nets }: { nets?: string[] }) => {
    const data = await checkConnectivity(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_current_density_report', '各网络载流能力估算（IPC-2221，线宽总和 → 电流容量），标记偏低网络', {}, async () => {
    const data = await currentDensityReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_fanout_component', '为指定元件的所有焊盘创建扇出过孔（同一网络）', {
    designator: z.string().describe('元件位号，如 U1'),
  }, async ({ designator }: { designator: string }) => {
    const data = await fanoutComponent(bridge, { designator });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_auto_route_nets', '基础自动布线：对指定网络（默认全部）做 L 型两层布线（顶层水平+底层垂直+过孔）。适合预布线，需 DRC 复查', {
    nets: z.array(z.string()).optional().describe('要布线的网络列表（默认全部）'),
    topLayer: z.number().optional().describe('水平走线层（默认 1 顶层）'),
    viaLayer: z.number().optional().describe('垂直走线层（默认 2 底层）'),
    width: z.number().optional().describe('线宽 mil（默认 10）'),
  }, async ({ nets, topLayer, viaLayer, width }: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number }) => {
    const data = await autoRouteNets(bridge, { nets, topLayer, viaLayer, width });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_drc_autofix', '运行 DRC 并自动修复可自动处理的问题（当前：丝印冲突），返回修复前后对比', {}, async () => {
    const data = await drcAutoFix(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
