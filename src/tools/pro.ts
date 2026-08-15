/**
 * tools/pro.ts — 高级功能（v1.1）
 *
 * 全部基于官方 Bridge（eda.* API）实现，运行于 MCP Server 进程内，
 * 数据通过 bridge.command / bridge.executeRaw 获取与写回。
 */
import { z } from 'zod';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BridgeClient } from '../bridge-client.js';

// ─── 类型 ────────────────────────────────────────────────────────────
interface Comp { designator: string; name: string; x: number; y: number; width: number; height: number; padNets: string[]; locked?: boolean; rotation?: number; }
interface Pad { primitiveId: string; net: string; x: number; y: number; designator: string; diameter?: number; holeDiameter?: number; }
interface Track { primitiveId: string; net: string; layer: number | string; startX: number; startY: number; endX: number; endY: number; width: number; }

// IPC-2221 外层电流容量（A），与 calculators.ts 同一公式
function ipcCurrent(areaMil2: number): number {
  const areaMm2 = areaMil2 * 0.00064516;
  return 0.048 * Math.pow(areaMm2, 0.44) * 1000;
}

// ─── 1. BOM 导出 ─────────────────────────────────────────────────────
export async function exportBom(bridge: BridgeClient, opts?: { lcscCodes?: Record<string, string> }): Promise<any> {
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
  const lcscCodes = opts?.lcscCodes ?? {};
  const items = Array.from(byName.entries())
    .map(([name, v]) => ({
      name,
      quantity: v.count,
      designators: v.designators.sort(),
      nets: Array.from(v.padNets).sort(),
      lcscCode: lcscCodes[name] || lcscCodes[v.designators[0]] || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const csv = [
    'name,quantity,designators,nets,lcsc',
    ...items.map((i) => [i.name, i.quantity, i.designators.join(' '), i.nets.join(' '), i.lcscCode || ''].join(',')),
  ].join('\n');
  return {
    componentCount: comps.length,
    itemCount: items.length,
    items,
    csv,
    note: 'LCSC 料号需手动提供（LCSC API 受保护，无法自动查询）；可用 pcb_bom_export 的 lcscCodes 参数映射',
  };
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


// ─── 7. 元件间距检查 ─────────────────────────────────────────────────
export async function componentClearanceCheck(bridge: BridgeClient, params: { minClearance?: number }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const minClearance = params.minClearance ?? 20; // mil
  const violations: any[] = [];
  for (let i = 0; i < comps.length; i += 1) {
    for (let j = i + 1; j < comps.length; j += 1) {
      const a = comps[i];
      const b = comps[j];
      const dx = Math.abs(a.x - b.x) - (a.width + b.width) / 2;
      const dy = Math.abs(a.y - b.y) - (a.height + b.height) / 2;
      const gap = Math.max(dx, 0) === 0 && Math.max(dy, 0) === 0 ? -Math.max(-dx, -dy) : Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      if (gap < minClearance) {
        violations.push({ a: a.designator, b: b.designator, gapMil: Math.round(gap * 10) / 10, minClearance });
      }
    }
  }
  return {
    componentCount: comps.length,
    checkedPairs: (comps.length * (comps.length - 1)) / 2,
    minClearance,
    violations,
    violationCount: violations.length,
  };
}

// ─── 8. 差分对布线 ───────────────────────────────────────────────────
export async function routeDifferentialPairs(bridge: BridgeClient, params: { pairName?: string; layer?: number; width?: number; gap?: number }): Promise<any> {
  const list: any = await bridge.command('list_differential_pairs');
  const pairs: any[] = Array.isArray(list?.pairs) ? list.pairs : [];
  const targets = params.pairName ? pairs.filter((p) => String(p.name) === params.pairName) : pairs;
  const layer = params.layer ?? 1;
  const width = params.width ?? 6;
  const gap = params.gap ?? 8;

  const routed: any[] = [];
  for (const pair of targets) {
    const posPads: any = await bridge.command('get_pads', { nets: pair.positiveNet });
    const negPads: any = await bridge.command('get_pads', { nets: pair.negativeNet });
    const pos = Array.isArray(posPads?.pads) ? posPads.pads : [];
    const neg = Array.isArray(negPads?.pads) ? negPads.pads : [];
    if (pos.length < 2 || neg.length < 2) {
      routed.push({ pair: pair.name, skipped: '正/负网络焊盘不足' });
      continue;
    }
    // 正网络：L 型链式连接；负网络：在正网络路径基础上横向偏移 gap（保持平行）
    const posOrder = [...pos].sort((a: any, b: any) => a.x - b.x || a.y - b.y);
    const negOrder = [...neg].sort((a: any, b: any) => a.x - b.x || a.y - b.y);
    let segments = 0;
    for (let i = 0; i < posOrder.length - 1; i += 1) {
      const a = posOrder[i];
      const b = posOrder[i + 1];
      const midX = Math.round((a.x + b.x) / 2);
      await bridge.command('route_track', { net: pair.positiveNet, points: [{ x: a.x, y: a.y }, { x: midX, y: a.y }], layer, width });
      await bridge.command('route_track', { net: pair.positiveNet, points: [{ x: midX, y: a.y }, { x: midX, y: b.y }, { x: b.x, y: b.y }], layer, width });
      segments += 2;
    }
    let negSegments = 0;
    for (let i = 0; i < negOrder.length - 1; i += 1) {
      const a = negOrder[i];
      const b = negOrder[i + 1];
      // 负网络走线整体向 y+gap 偏移，保持与正网络平行
      const midX = Math.round((a.x + b.x) / 2);
      await bridge.command('route_track', { net: pair.negativeNet, points: [{ x: a.x, y: a.y + gap }, { x: midX, y: a.y + gap }], layer, width });
      await bridge.command('route_track', { net: pair.negativeNet, points: [{ x: midX, y: a.y + gap }, { x: midX, y: b.y + gap }, { x: b.x, y: b.y + gap }], layer, width });
      negSegments += 2;
    }
    // 估算等长偏差（按 Manhattan 路径长度）
    const len = (nets: any[]) => {
      let total = 0;
      for (let i = 0; i < nets.length - 1; i += 1) {
        total += Math.abs(nets[i + 1].x - nets[i].x) + Math.abs(nets[i + 1].y - nets[i].y);
      }
      return total;
    };
    const posLen = len(posOrder);
    const negLen = len(negOrder);
    routed.push({
      pair: pair.name,
      positiveNet: pair.positiveNet,
      negativeNet: pair.negativeNet,
      positiveSegments: segments,
      negativeSegments: negSegments,
      positiveLengthMil: posLen,
      negativeLengthMil: negLen,
      lengthDeltaMil: Math.abs(posLen - negLen),
      note: '平行 L 型走线（负网络 +' + gap + 'mil 偏移），等长偏差用 create_equal_length 校验',
    });
  }
  return { routedPairs: routed.length, layer, width, gap, pairs: routed };
}

// ─── 9. 设计健康报告 ─────────────────────────────────────────────────
export async function designHealthReport(bridge: BridgeClient): Promise<any> {
  const [bom, conn, dens, drc, clear] = await Promise.all([
    exportBom(bridge),
    checkConnectivity(bridge),
    currentDensityReport(bridge),
    bridge.command('run_drc'),
    componentClearanceCheck(bridge, {}),
  ]) as any[];
  const issues: string[] = [];
  if (!drc?.passed) issues.push('DRC 存在 ' + (drc?.totalCount ?? 0) + ' 个问题');
  if ((conn as any).unrouted > 0) issues.push('存在 ' + (conn as any).unrouted + ' 个未布线网络');
  if ((conn as any).singlePadNets > 0) issues.push('存在 ' + (conn as any).singlePadNets + ' 个单焊盘网络');
  if ((clear as any).violationCount > 0) issues.push('存在 ' + (clear as any).violationCount + ' 处元件间距违规');
  if ((dens as any).report.some((r: any) => r.warning)) issues.push('存在载流能力偏低网络');
  return {
    generatedAt: new Date().toISOString(),
    score: issues.length === 0 ? 'READY' : issues.length <= 2 ? 'NEEDS_WORK' : 'POOR',
    summary: {
      components: bom.componentCount,
      bomItems: bom.itemCount,
      nets: conn.totalNets,
      routedNets: conn.routed,
      unrouted: conn.unrouted,
      drcPassed: Boolean(drc?.passed),
      drcIssues: Number(drc?.totalCount ?? 0),
      clearanceViolations: clear.violationCount,
      currentWarnings: dens.report.filter((r: any) => r.warning).length,
    },
    issues,
    bom: bom.items,
    connectivity: conn.nets,
    currentDensity: dens.report,
    drc: drc?.issues?.slice?.(0, 20) ?? [],
    clearance: clear.violations.slice(0, 20),
  };
}

// ─── 10. 扇出 + 布线 + DRC 流水线 ────────────────────────────────────
export async function autoFanoutAndRoute(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const fanoutResults: any[] = [];
  for (const c of comps) {
    const f = await fanoutComponent(bridge, { designator: c.designator });
    fanoutResults.push(f);
  }
  const route = await autoRouteNets(bridge, {});
  const drc: any = await bridge.command('run_drc');
  const fix = await drcAutoFix(bridge);
  return {
    fanout: { components: fanoutResults.length, viasCreated: fanoutResults.reduce((s, f) => s + f.fanoutCreated, 0) },
    routing: route,
    drcBefore: { passed: drc?.passed, totalCount: drc?.totalCount },
    autoFixes: fix.fixesApplied,
    drcAfter: fix.after,
    note: '流水线：全部元件扇出 → 全部网络自动布线 → DRC → 丝印自动修复。请人工复核后用 pcb_design_health_report 复检。',
  };
}


// ─── 11. 自动布局（质心优化）─────────────────────────────────────────
export async function autoPlaceComponents(bridge: BridgeClient, params: { maxMoves?: number }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const padResult: any = await bridge.command('get_pads');
  const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
  const maxMoves = params.maxMoves ?? 100;

  // 每个元件 → 其焊盘质心（保持元件中心与焊盘中心一致是简化假设）
  const byDesignator = new Map<string, { x: number; y: number; count: number }>();
  for (const p of pads) {
    if (!p.designator) continue;
    const acc = byDesignator.get(p.designator) || { x: 0, y: 0, count: 0 };
    acc.x += p.x;
    acc.y += p.y;
    acc.count += 1;
    byDesignator.set(p.designator, acc);
  }

  const details: any[] = [];
  let moved = 0;
  for (const c of comps) {
    if (moved >= maxMoves) break;
    const acc = byDesignator.get(c.designator);
    if (!acc || acc.count === 0) continue;
    const cx = Math.round(acc.x / acc.count);
    const cy = Math.round(acc.y / acc.count);
    const dx = Math.abs(cx - c.x);
    const dy = Math.abs(cy - c.y);
    if (dx < 1 && dy < 1) continue; // 已就位
    if (c.locked) continue;
    await bridge.command('move_component', { designator: c.designator, x: cx, y: cy, rotation: c.rotation ?? 0 });
    moved += 1;
    details.push({
      designator: c.designator,
      from: { x: c.x, y: c.y },
      to: { x: cx, y: cy },
      deltaMil: Math.round(Math.hypot(dx, dy) * 10) / 10,
    });
  }
  return {
    moved,
    totalComponents: comps.length,
    details,
    note: '质心布局：把每个元件移动到其焊盘质心（一阶优化），锁定元件跳过；后续可用 pcb_component_clearance_check 复核间距',
  };
}

// ─── 12. 障碍规避自动布线 ───────────────────────────────────────────
interface Obstacle { x: number; y: number; r: number; net: string; }

function segCircleDist(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((cx - x1) * dx + (cy - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(cx - px, cy - py);
}

function segmentClear(x1: number, y1: number, x2: number, y2: number, obstacles: Obstacle[], selfNets: Set<string>): boolean {
  for (const o of obstacles) {
    // 同网络的焊盘不是障碍（要连到它们）
    if (selfNets.has(o.net)) continue;
    if (segCircleDist(x1, y1, x2, y2, o.x, o.y) < o.r) return false;
  }
  return true;
}

function routeChainPoints(pads: Pad[], obstacles: Obstacle[], selfNets: Set<string>): { points: Array<{ x: number; y: number }>; detours: number } {
  const ordered = [...pads].sort((a, b) => a.x - b.x || a.y - b.y);
  const out: Array<{ x: number; y: number }> = [];
  let detours = 0;
  for (let i = 0; i < ordered.length - 1; i += 1) {
    const a = ordered[i];
    const b = ordered[i + 1];
    if (segmentClear(a.x, a.y, b.x, b.y, obstacles, selfNets)) {
      if (out.length === 0) out.push({ x: a.x, y: a.y });
      out.push({ x: b.x, y: b.y });
      continue;
    }
    // L 型：先水平后垂直 / 先垂直后水平
    const l1 = [
      { x: a.x, y: a.y },
      { x: b.x, y: a.y },
      { x: b.x, y: b.y },
    ];
    const l2 = [
      { x: a.x, y: a.y },
      { x: a.x, y: b.y },
      { x: b.x, y: b.y },
    ];
    const l1ok = segmentClear(l1[0].x, l1[0].y, l1[1].x, l1[1].y, obstacles, selfNets) && segmentClear(l1[1].x, l1[1].y, l1[2].x, l1[2].y, obstacles, selfNets);
    const l2ok = segmentClear(l2[0].x, l2[0].y, l2[1].x, l2[1].y, obstacles, selfNets) && segmentClear(l2[1].x, l2[1].y, l2[2].x, l2[2].y, obstacles, selfNets);
    if (l1ok || l2ok) {
      const path = l1ok ? l1 : l2;
      if (out.length === 0) out.push(path[0]);
      out.push(path[1], path[2]);
      detours += 1;
      continue;
    }
    // Z 型：垂直偏移 detour
    const midY = Math.round((a.y + b.y) / 2);
    const z = [
      { x: a.x, y: a.y },
      { x: a.x, y: midY },
      { x: b.x, y: midY },
      { x: b.x, y: b.y },
    ];
    const zok =
      segmentClear(z[0].x, z[0].y, z[1].x, z[1].y, obstacles, selfNets) &&
      segmentClear(z[1].x, z[1].y, z[2].x, z[2].y, obstacles, selfNets) &&
      segmentClear(z[2].x, z[2].y, z[3].x, z[3].y, obstacles, selfNets);
    if (zok) {
      if (out.length === 0) out.push(z[0]);
      out.push(z[1], z[2], z[3]);
      detours += 1;
      continue;
    }
    // 直连兜底
    if (out.length === 0) out.push({ x: a.x, y: a.y });
    out.push({ x: b.x, y: b.y });
  }
  return { points: out, detours };
}

export async function autoRouteNets(bridge: BridgeClient, params: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number; clearance?: number; useVias?: boolean }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const allNets: string[] = Array.isArray(state?.nets) ? state.nets.map((n: any) => n.name).filter(Boolean) : [];
  const targets = Array.isArray(params.nets) && params.nets.length > 0 ? params.nets.map(String) : allNets;
  const topLayer = params.topLayer ?? 1;
  const viaLayer = params.viaLayer ?? 2;
  const width = params.width ?? 10;
  const clearance = params.clearance ?? 15;
  const useVias = Boolean(params.useVias);

  // 障碍集合：所有焊盘（含直径），加上 clearance
  const padResult: any = await bridge.command('get_pads');
  const allPads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
  const obstacles: Obstacle[] = allPads
    .filter((p) => p.net && p.x !== undefined && p.y !== undefined)
    .map((p) => ({ x: p.x, y: p.y, r: (p.diameter ?? 30) / 2 + clearance, net: p.net }));

  const summary: any[] = [];
  let totalTracks = 0;
  let totalVias = 0;
  let totalDetours = 0;
  for (const net of targets) {
    const pads = allPads.filter((p) => p.net === net);
    if (pads.length < 2) { summary.push({ net, pads: pads.length, segments: 0, vias: 0, skipped: '不足 2 个焊盘' }); continue; }

    if (useVias) {
      // 两层 L 型（旧行为）
      const ordered = [...pads].sort((a, b) => a.x - b.x || a.y - b.y);
      let segments = 0;
      let vias = 0;
      for (let i = 0; i < ordered.length - 1; i += 1) {
        const a = ordered[i];
        const b = ordered[i + 1];
        const midX = Math.round((a.x + b.x) / 2);
        await bridge.command('route_track', { net, points: [{ x: a.x, y: a.y }, { x: midX, y: a.y }], layer: topLayer, width });
        await bridge.command('create_via', { net, x: midX, y: a.y, holeDiameter: 8, diameter: 16 });
        await bridge.command('route_track', { net, points: [{ x: midX, y: a.y }, { x: midX, y: b.y }, { x: b.x, y: b.y }], layer: viaLayer, width });
        segments += 2;
        vias += 1;
      }
      totalTracks += segments;
      totalVias += vias;
      summary.push({ net, pads: pads.length, segments, vias });
    } else {
      // 单层障碍规避
      const { points, detours } = routeChainPoints(pads, obstacles, new Set([net]));
      const segments = points.length - 1;
      if (segments > 0) {
        // 分段发送（route_track 逐段画）
        for (let i = 0; i < points.length - 1; i += 1) {
          await bridge.command('route_track', { net, points: [points[i], points[i + 1]], layer: topLayer, width });
        }
      }
      totalTracks += segments;
      totalDetours += detours;
      summary.push({ net, pads: pads.length, segments, detours });
    }
  }
  return {
    routedNets: summary.length,
    totalTrackSegments: totalTracks,
    totalVias,
    totalDetours,
    mode: useVias ? 'two_layer_l' : 'single_layer_obstacle_aware',
    note: useVias
      ? '两层 L 型布线（顶层水平 + 底层垂直 + 过孔）'
      : '单层障碍规避布线（自动绕开焊盘，clearance=' + clearance + 'mil）；请用 pcb_run_drc 复查',
    nets: summary,
  };
}

// ─── 13. PCB 网表报告 ───────────────────────────────────────────────
export async function netlistReport(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const padResult: any = await bridge.command('get_pads');
  const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];

  const byDesignator = new Map<string, Pad[]>();
  for (const p of pads) {
    if (!p.designator) continue;
    const arr = byDesignator.get(p.designator) || [];
    arr.push(p);
    byDesignator.set(p.designator, arr);
  }
  const components = Array.from(byDesignator.entries()).map(([designator, ps]) => ({
    designator,
    pins: ps.map((p, i) => ({ pin: i + 1, net: p.net || '(no net)' })),
  }));

  const netToDesignators = new Map<string, string[]>();
  for (const p of pads) {
    if (!p.net || !p.designator) continue;
    const arr = netToDesignators.get(p.net) || [];
    if (!arr.includes(p.designator)) arr.push(p.designator);
    netToDesignators.set(p.net, arr);
  }
  const nets = Array.from(netToDesignators.entries())
    .map(([net, des]) => ({ net, designators: des.sort() }))
    .sort((a, b) => a.net.localeCompare(b.net));

  return { componentCount: comps.length, components, nets, note: '由 PCB 焊盘数据推导；引脚编号为近似顺序（按 get_pads 返回顺序）' };
}

// ─── 14. 设计快照 / 差异对比 ────────────────────────────────────────
let lastSnapshot: any = null;

function normalizeSnapshot(state: any): any {
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const byDes = new Map<string, any>();
  for (const c of comps) byDes.set(c.designator, { designator: c.designator, name: c.name, x: c.x, y: c.y, rotation: c.rotation });
  return { components: byDes };
}

export async function designSnapshot(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  lastSnapshot = normalizeSnapshot(state);
  return { snapshotTaken: true, componentCount: lastSnapshot.components.size, designators: Array.from(lastSnapshot.components.keys()).sort() };
}

export async function designDiff(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const cur = normalizeSnapshot(state);
  if (!lastSnapshot) {
    lastSnapshot = cur;
    return { note: '首次调用已建立快照基线（无对比）', componentCount: cur.components.size };
  }
  const added: string[] = [];
  const removed: string[] = [];
  const moved: any[] = [];
  for (const [des, c] of cur.components) {
    if (!lastSnapshot.components.has(des)) added.push(des);
    else {
      const prev = lastSnapshot.components.get(des);
      const dx = Math.abs(c.x - prev.x);
      const dy = Math.abs(c.y - prev.y);
      if (dx >= 1 || dy >= 1) moved.push({ designator: des, from: { x: prev.x, y: prev.y }, to: { x: c.x, y: c.y }, deltaMil: Math.round(Math.hypot(dx, dy) * 10) / 10 });
    }
  }
  for (const des of lastSnapshot.components.keys()) {
    if (!cur.components.has(des)) removed.push(des);
  }
  lastSnapshot = cur;
  return { added, removed, moved, addedCount: added.length, removedCount: removed.length, movedCount: moved.length };
}


// ─── 15. 网表 → 原理图（官方 sch_Netlist.setNetlist）────────────────
export const NETLIST_TYPES = ['EasyEDA', 'JLCEDA', 'Protel2', 'PADS', 'Allegro', 'DISA', 'DSNET'] as const;

export async function schGenerateFromNetlist(bridge: BridgeClient, params: { netlist: string; type?: string }): Promise<any> {
  const netlist = String(params.netlist ?? '');
  if (!netlist.trim()) throw new Error('netlist 不能为空');
  const type = params.type ?? 'Protel2';
  if (!(NETLIST_TYPES as readonly string[]).includes(type)) {
    throw new Error('不支持的网表类型: ' + type + '（可选: ' + NETLIST_TYPES.join(', ') + '）');
  }
  const code =
    'const r = await eda.sch_Netlist.setNetlist(' + JSON.stringify(type) + ', ' + JSON.stringify(netlist) + ');' +
    'return { ok: true, type: ' + JSON.stringify(type) + ', netlistLength: ' + JSON.stringify(netlist.length) + ' };';
  const data = await bridge.executeRaw(code);
  return { ok: (data as any)?.ok ?? true, type, netlistLength: netlist.length, note: '已调用官方 sch_Netlist.setNetlist(' + type + ') 更新原理图网表' };
}

/** 把 PCB 网表报告转为 Protel2 格式文本 */
export function netlistToProtel2(report: any): string {
  const nets = Array.isArray(report?.nets) ? report.nets : [];
  const blocks: string[] = [];
  for (const n of nets) {
    const name = String(n.net || '');
    if (!name) continue;
    const pins = Array.isArray(n.designators) ? n.designators : [];
    const lines = [name];
    // 需要引脚级信息：从 components 里查
    const comps = Array.isArray(report?.components) ? report.components : [];
    for (const c of comps) {
      const pinsOf = Array.isArray(c?.pins) ? c.pins : [];
      for (const p of pinsOf) {
        if (p.net === name) lines.push(c.designator + '-' + p.pin);
      }
    }
    blocks.push('[' + lines.join('\n') + ']');
  }
  return blocks.join('\n\n');
}

export async function schGenerateFromPcb(bridge: BridgeClient, params: { type?: string }): Promise<any> {
  const report: any = await netlistReport(bridge);
  const protel2 = netlistToProtel2(report);
  const imp = await schGenerateFromNetlist(bridge, { netlist: protel2, type: params.type ?? 'Protel2' });
  return { ...imp, source: 'pcb_netlist_report', protel2Netlist: protel2 };
}

// ─── 16. eprj3 工程检查器 ────────────────────────────────────────────
const EPRJ3_EXTS = ['.eprj3', '.esch2', '.epcb2', '.epan2', '.ecfg', '.evar'];

export async function eprj3ProjectInfo(projectPath: string): Promise<any> {
  const p = String(projectPath || '').trim();
  if (!p) throw new Error('projectPath 不能为空');
  if (!existsSync(p)) throw new Error('路径不存在: ' + p);

  const stat = statSync(p);
  if (stat.isFile()) {
    const ext = path.extname(p).toLowerCase();
    if (!EPRJ3_EXTS.includes(ext)) throw new Error('不是 eprj3 工程文件: ' + ext);
    const raw = readFileSync(p, 'utf8');
    if (ext === '.eprj3') {
      let json: any;
      try { json = JSON.parse(raw); } catch { json = null; }
      return { kind: 'project-index', file: path.basename(p), sizeBytes: raw.length, keys: json ? Object.keys(json) : [], json };
    }
    // JSON-lines 记录文件（.esch2/.epcb2/.epan2/.ecfg/.evar）
    const records = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const byType = new Map<string, number>();
    let meta: any = null;
    let parsed = 0;
    for (const line of records) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.type === 'string') {
          byType.set(obj.type, (byType.get(obj.type) || 0) + 1);
          if (obj.type === 'META' && meta === null) meta = obj;
        }
        parsed += 1;
      } catch { /* 跳过非 JSON 行 */ }
    }
    return {
      kind: 'source-records',
      file: path.basename(p),
      recordCount: records.length,
      parsedRecords: parsed,
      recordTypes: Object.fromEntries(byType),
      meta,
    };
  }

  // 目录：工程根
  const entries = readdirSync(p);
  const eprj3File = entries.find((f) => f.toLowerCase().endsWith('.eprj3'));
  let index: any = null;
  if (eprj3File) {
    try { index = JSON.parse(readFileSync(path.join(p, eprj3File), 'utf8')); } catch { index = null; }
  }
  const collect = (dir: string, ext: string): string[] => {
    const abs = path.join(p, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
    const results: string[] = [];
    const walkDir = (d: string) => {
      for (const f of readdirSync(d)) {
        const full = path.join(d, f);
        if (statSync(full).isDirectory()) walkDir(full);
        else if (f.toLowerCase().endsWith(ext)) results.push(path.relative(p, full));
      }
    };
    walkDir(abs);
    return results;
  };
  const schematics = collect('sch', '.esch2');
  const pcbs = collect('pcb', '.epcb2');
  const panels = collect('panel', '.epan2');
  const schematicNames = readdirSync(path.join(p, 'sch')).filter((f) => statSync(path.join(p, 'sch', f)).isDirectory()).filter(() => true).slice(0, 50);
  return {
    kind: 'project-folder',
    projectName: eprj3File ? eprj3File.replace(/\.eprj3$/i, '') : '(未找到 .eprj3)',
    eprj3File: eprj3File || null,
    indexKeys: index ? Object.keys(index) : [],
    schematicFolders: schematicNames,
    schematicSheets: schematics,
    pcbFiles: pcbs,
    panelFiles: panels,
  };
}

// ─── MCP 注册 ────────────────────────────────────────────────────────
export function registerProTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_bom_export', '导出 PCB BOM（按元件名聚合：数量、位号、网络、LCSC 料号），返回 JSON + CSV', {
    lcscCodes: z.record(z.string()).optional().describe('元件名 → LCSC 料号映射（如 {"R-10k":"C25744"}，LCSC API 受保护无法自动查询）'),
  }, async ({ lcscCodes }: { lcscCodes?: Record<string, string> }) => {
    const data = await exportBom(bridge, { lcscCodes });
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

  server.tool('pcb_auto_route_nets', '自动布线：单层障碍规避（默认，绕开焊盘+clearance）或两层 L 型（useVias）。需 DRC 复查', {
    nets: z.array(z.string()).optional().describe('要布线的网络列表（默认全部）'),
    topLayer: z.number().optional().describe('布线层（默认 1 顶层）'),
    viaLayer: z.number().optional().describe('垂直走线层（useVias 时，默认 2 底层）'),
    width: z.number().optional().describe('线宽 mil（默认 10）'),
    clearance: z.number().optional().describe('障碍间距 mil（默认 15）'),
    useVias: z.boolean().optional().describe('true=两层 L 型（含过孔）；false/缺省=单层障碍规避'),
  }, async ({ nets, topLayer, viaLayer, width, clearance, useVias }: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number; clearance?: number; useVias?: boolean }) => {
    const data = await autoRouteNets(bridge, { nets, topLayer, viaLayer, width, clearance, useVias });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_drc_autofix', '运行 DRC 并自动修复可自动处理的问题（当前：丝印冲突），返回修复前后对比', {}, async () => {
    const data = await drcAutoFix(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('pcb_component_clearance_check', '检查所有元件对的最小间距，标记低于阈值的违规对', {
    minClearance: z.number().optional().describe('最小间距 mil（默认 20）'),
  }, async ({ minClearance }: { minClearance?: number }) => {
    const data = await componentClearanceCheck(bridge, { minClearance });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_route_differential_pairs', '差分对自动布线：正/负网络平行 L 型走线（负网络偏移 gap），报告等长偏差', {
    pairName: z.string().optional().describe('指定差分对名称（默认全部）'),
    layer: z.number().optional().describe('走线层（默认 1 顶层）'),
    width: z.number().optional().describe('线宽 mil（默认 6）'),
    gap: z.number().optional().describe('正负线间距 mil（默认 8）'),
  }, async ({ pairName, layer, width, gap }: { pairName?: string; layer?: number; width?: number; gap?: number }) => {
    const data = await routeDifferentialPairs(bridge, { pairName, layer, width, gap });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_health_report', '一键输出设计健康报告：BOM + 连通性 + 载流 + DRC + 间距，给出 READY/NEEDS_WORK/POOR 评分', {}, async () => {
    const data = await designHealthReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_auto_fanout_and_route', '流水线：全部元件扇出 → 全部网络自动布线 → DRC → 丝印自修复', {}, async () => {
    const data = await autoFanoutAndRoute(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('pcb_auto_place_components', '自动布局：把元件移动到其焊盘质心（一阶优化），锁定元件跳过', {
    maxMoves: z.number().optional().describe('最大移动数（默认 100）'),
  }, async ({ maxMoves }: { maxMoves?: number }) => {
    const data = await autoPlaceComponents(bridge, { maxMoves });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_netlist_report', '从 PCB 焊盘数据生成网表报告（元件→引脚→网络、网络→元件）', {}, async () => {
    const data = await netlistReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_snapshot', '保存当前设计快照（作为后续 pcb_design_diff 的基线）', {}, async () => {
    const data = await designSnapshot(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_diff', '对比当前设计与上次快照，报告新增/移除/移动的元件', {}, async () => {
    const data = await designDiff(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('sch_generate_from_netlist', '通过官方 sch_Netlist.setNetlist 将网表导入原理图（生成原理图）。类型: EasyEDA/JLCEDA/Protel2/PADS/Allegro/DISA/DSNET', {
    netlist: z.string().describe('网表内容（Protel2 示例: [GND\nU1-1\nR1-2\n]）'),
    type: z.string().optional().describe('网表格式（默认 Protel2）'),
  }, async ({ netlist, type }: { netlist: string; type?: string }) => {
    const data = await schGenerateFromNetlist(bridge, { netlist, type });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_generate_from_pcb', '一键：读取当前 PCB 网表报告 → 转 Protel2 网表 → 导入原理图生成', {
    type: z.string().optional().describe('网表格式（默认 Protel2）'),
  }, async ({ type }: { type?: string }) => {
    const data = await schGenerateFromPcb(bridge, { type });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_eprj3_project_info', '检查嘉立创EDA专业版 .eprj3 工程（目录或文件）：工程索引、原理图/PCB/面板文件清单，或源文件记录统计（JSON-lines）', {
    projectPath: z.string().describe('.eprj3 工程根目录路径，或 .eprj3/.epcb2/.esch2 等文件路径'),
  }, async ({ projectPath }: { projectPath: string }) => {
    const data = await eprj3ProjectInfo(projectPath);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
