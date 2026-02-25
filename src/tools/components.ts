import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerComponentTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_move_component', '移动元件到指定坐标 (mil)', {
    designator: z.string().describe('元件位号，如 U1, R1'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    rotation: z.number().optional().describe('旋转角度'),
  }, async ({ designator, x, y, rotation }: { designator: string; x: number; y: number; rotation?: number }) => {
    const params: Record<string, unknown> = { designator, x, y };
    if (rotation !== undefined) params.rotation = rotation;
    const data = await bridge.command('move_component', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_relocate_component', '安全搬迁元件（自动断开走线）', {
    designator: z.string().describe('元件位号'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    rotation: z.number().optional().describe('旋转角度'),
  }, async ({ designator, x, y, rotation }: { designator: string; x: number; y: number; rotation?: number }) => {
    const params: Record<string, unknown> = { designator, x, y };
    if (rotation !== undefined) params.rotation = rotation;
    const data = await bridge.command('relocate_component', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_batch_move', '批量移动多个元件', {
    moves: z.array(z.object({
      designator: z.string(),
      x: z.number(),
      y: z.number(),
      rotation: z.number().optional(),
    })).describe('移动列表 [{designator, x, y, rotation?}]'),
  }, async ({ moves }: { moves: { designator: string; x: number; y: number; rotation?: number }[] }) => {
    const results = { success: [] as string[], failed: [] as { designator: string; error: string }[] };
    for (const m of moves) {
      try {
        const params: Record<string, unknown> = { designator: m.designator, x: m.x, y: m.y };
        if (m.rotation !== undefined) params.rotation = m.rotation;
        await bridge.command('move_component', params);
        results.success.push(m.designator);
      } catch (e: any) {
        results.failed.push({ designator: m.designator, error: e.message });
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.tool('pcb_select_component', '在编辑器中选中元件', {
    designator: z.string().describe('元件位号'),
  }, async ({ designator }: { designator: string }) => {
    const data = await bridge.command('select_component', { designator });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_selected', '删除当前选中的对象', {}, async () => {
    const data = await bridge.command('delete_selected');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_create_component', '从库中放置元件到 PCB', {
    libraryUuid: z.string().describe('库 UUID'),
    componentUuid: z.string().describe('元件 UUID'),
    layer: z.number().describe('层号 (1=顶层, 2=底层)'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    rotation: z.number().optional().describe('旋转角度'),
  }, async ({ libraryUuid, componentUuid, layer, x, y, rotation }: { libraryUuid: string; componentUuid: string; layer: number; x: number; y: number; rotation?: number }) => {
    const params: Record<string, unknown> = {
      component: { libraryUuid, uuid: componentUuid },
      layer, x, y,
    };
    if (rotation !== undefined) params.rotation = rotation;
    const data = await bridge.command('create_pcb_component', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
