import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';
import { ServiceClient } from '../service-client.js';

const MIL_TO_MM = 0.0254;

interface BridgeComponent {
  primitiveId: string;
  designator: string;
  name: string;
  x: number; y: number;
  rotation: number;
  width: number; height: number;
  layer: string;
  locked: boolean;
  padNets: { pad: string; net: string }[];
}

interface BridgeState {
  components: BridgeComponent[];
  nets: { name: string; length?: number }[];
  boardBounds: { minX: number; minY: number; maxX: number; maxY: number };
  layerCount: number;
}

function edaLayerToIR(layer: string): string {
  const l = layer?.toLowerCase?.() ?? '';
  if (['top', 'toplayer', '1'].includes(l)) return 'F.Cu';
  if (['bottom', 'bottomlayer', '2'].includes(l)) return 'B.Cu';
  return 'F.Cu';
}

function bridgeStateToIR(state: BridgeState): Record<string, unknown> {
  const bounds = state.boardBounds;
  const w = (bounds.maxX - bounds.minX) * MIL_TO_MM;
  const h = (bounds.maxY - bounds.minY) * MIL_TO_MM;

  const pads: Record<string, unknown>[] = [];
  const components = state.components.map((c, ci) => {
    const compPads = (c.padNets ?? []).map((pn, pi) => {
      const padId = `pad_${ci}_${pi}`;
      const pad = {
        id: padId,
        componentId: c.primitiveId,
        netId: pn.net,
        x: c.x * MIL_TO_MM,
        y: c.y * MIL_TO_MM,
        shape: 'rect',
        width: 1, height: 1,
        layer: edaLayerToIR(c.layer),
      };
      pads.push(pad);
      return padId;
    });
    return {
      id: c.primitiveId,
      designator: c.designator,
      footprint: c.name,
      x: c.x * MIL_TO_MM,
      y: c.y * MIL_TO_MM,
      rotation: c.rotation,
      layer: edaLayerToIR(c.layer),
      width: c.width * MIL_TO_MM,
      height: c.height * MIL_TO_MM,
      padIds: compPads,
      locked: c.locked,
    };
  });

  const nets = state.nets.map(n => ({
    id: n.name,
    name: n.name,
    pinRefs: [] as unknown[],
  }));

  return {
    version: '1.0',
    board: { width: w, height: h, points: [], layers: state.layerCount || 2 },
    components,
    nets,
    pads,
    traces: [],
    vias: [],
    silkscreens: [],
    copperAreas: [],
    keepoutZones: [],
    designRules: {
      minTraceWidth: 0.15,
      minClearance: 0.15,
      minViaDrill: 0.3,
      minViaDiameter: 0.6,
      defaultTraceWidth: 0.25,
    },
  };
}

const MM_TO_MIL = 1 / MIL_TO_MM;

export function registerServiceTools(server: any, bridge: BridgeClient, services: ServiceClient) {
  server.tool('service_auto_place', '调用引擎自动布局（DREAMPlace / RL_PCB）', {
    engine: z.string().optional().describe("引擎: 'auto' | 'rl_pcb' | 'dreamplace'（默认 auto）"),
    options: z.record(z.unknown()).optional().describe('引擎选项'),
  }, async ({ engine, options }: { engine?: string; options?: Record<string, unknown> }) => {
    // 1. Get current state from bridge
    const state = await bridge.command('get_state') as BridgeState;
    // 2. Convert to IR
    const ir = bridgeStateToIR(state);
    // 3. Call placement service
    const result = await services.place(ir, engine ?? 'auto', options ?? {}) as any;
    // 4. Apply results back — move each component
    const placedIR = result.ir_data ?? result;
    const placedComps = (placedIR.components ?? []) as { id: string; designator: string; x: number; y: number; rotation: number }[];
    const applied = { success: [] as string[], failed: [] as { designator: string; error: string }[] };
    for (const comp of placedComps) {
      try {
        const params: Record<string, unknown> = {
          designator: comp.designator,
          x: comp.x * MM_TO_MIL,
          y: comp.y * MM_TO_MIL,
        };
        if (comp.rotation !== undefined) params.rotation = comp.rotation;
        await bridge.command('move_component', params);
        applied.success.push(comp.designator);
      } catch (e: any) {
        applied.failed.push({ designator: comp.designator, error: e.message });
      }
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          engine: result.engine ?? engine,
          metrics: result.metrics,
          applied,
        }, null, 2),
      }],
    };
  });

  server.tool('service_auto_route', '调用 Freerouting 自动布线', {
    options: z.record(z.unknown()).optional().describe('布线选项'),
  }, async ({ options }: { options?: Record<string, unknown> }) => {
    const state = await bridge.command('get_state') as BridgeState;
    const ir = bridgeStateToIR(state);
    const result = await services.route(ir, options ?? {}) as any;
    const routedIR = result.routed_ir ?? result;
    // Apply traces and vias back
    let tracesCreated = 0;
    let viasCreated = 0;
    const failed: string[] = [];
    for (const trace of (routedIR.traces ?? [])) {
      try {
        const pts = (trace.points ?? []).map((p: any) => ({ x: p.x * MM_TO_MIL, y: p.y * MM_TO_MIL }));
        const layer = trace.layer === 'B.Cu' ? 2 : 1;
        await bridge.command('route_track', {
          net: trace.netId, points: pts, layer, width: (trace.width ?? 0.25) * MM_TO_MIL,
        });
        tracesCreated++;
      } catch (e: any) { failed.push(`trace ${trace.id}: ${e.message}`); }
    }
    for (const via of (routedIR.vias ?? [])) {
      try {
        await bridge.command('create_via', {
          net: via.netId,
          x: via.x * MM_TO_MIL, y: via.y * MM_TO_MIL,
          drill: (via.drill ?? 0.3) * MM_TO_MIL,
          diameter: (via.diameter ?? 0.6) * MM_TO_MIL,
        });
        viasCreated++;
      } catch (e: any) { failed.push(`via ${via.id}: ${e.message}`); }
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ metrics: result.metrics, tracesCreated, viasCreated, failed }, null, 2),
      }],
    };
  });

  server.tool('service_convert', '格式转换（IR ↔ JLC/KiCad/LEF_DEF/DSN）', {
    data: z.string().describe('源数据'),
    fromFormat: z.string().describe("源格式: 'jlc'|'kicad'|'lef_def'|'dsn'|'ses'|'ir'"),
    toFormat: z.string().describe('目标格式'),
    data2: z.string().optional().describe('辅助数据（LEF/DEF 时的 DEF）'),
    baseIr: z.string().optional().describe('SES 合并用的基础 IR'),
  }, async ({ data, fromFormat, toFormat, data2, baseIr }: { data: string; fromFormat: string; toFormat: string; data2?: string; baseIr?: string }) => {
    const extra: Record<string, string> = {};
    if (data2) extra.data2 = data2;
    if (baseIr) extra.base_ir = baseIr;
    const result = await services.convert(data, fromFormat, toFormat, extra);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('service_health', '检查所有后端服务状态', {}, async () => {
    const health = await services.healthAll();
    return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] };
  });
}
