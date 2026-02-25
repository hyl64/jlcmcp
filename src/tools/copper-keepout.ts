import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerCopperKeepoutTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_create_copper_pour', '创建矩形铺铜区域', {
    net: z.string().describe('网络名称（如 GND）'),
    layer: z.number().describe('层号 (1=顶层, 2=底层)'),
    x1: z.number().describe('左上角 X (mil)'),
    y1: z.number().describe('左上角 Y (mil)'),
    x2: z.number().describe('右下角 X (mil)'),
    y2: z.number().describe('右下角 Y (mil)'),
  }, async ({ net, layer, x1, y1, x2, y2 }: { net: string; layer: number; x1: number; y1: number; x2: number; y2: number }) => {
    const data = await bridge.command('create_pour_rect', { net, layer, x1, y1, x2, y2 });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_pour', '删除铺铜', {
    primitiveId: z.string().describe('铺铜图元 ID'),
  }, async ({ primitiveId }: { primitiveId: string }) => {
    const data = await bridge.command('delete_pour', { primitiveId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_create_keepout', '创建矩形禁布区', {
    x1: z.number().describe('左上角 X (mil)'),
    y1: z.number().describe('左上角 Y (mil)'),
    x2: z.number().describe('右下角 X (mil)'),
    y2: z.number().describe('右下角 Y (mil)'),
    layer: z.number().optional().describe('层号（不填则所有层）'),
  }, async ({ x1, y1, x2, y2, layer }: { x1: number; y1: number; x2: number; y2: number; layer?: number }) => {
    const params: Record<string, unknown> = { x1, y1, x2, y2 };
    if (layer !== undefined) params.layer = layer;
    const data = await bridge.command('create_keepout_rect', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_keepout', '删除禁布区', {
    primitiveId: z.string().describe('禁布区图元 ID'),
  }, async ({ primitiveId }: { primitiveId: string }) => {
    const data = await bridge.command('delete_region', { primitiveId });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
