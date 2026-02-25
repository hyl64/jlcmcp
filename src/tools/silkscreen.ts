import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerSilkscreenTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_move_silkscreen', '移动丝印文字', {
    primitiveId: z.string().describe('丝印图元 ID'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    rotation: z.number().optional().describe('旋转角度'),
  }, async ({ primitiveId, x, y, rotation }: { primitiveId: string; x: number; y: number; rotation?: number }) => {
    const params: Record<string, unknown> = { primitiveId, x, y };
    if (rotation !== undefined) params.rotation = rotation;
    const data = await bridge.command('move_silkscreen', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_auto_silkscreen', '自动排列所有丝印（避免重叠）', {}, async () => {
    const data = await bridge.command('auto_silkscreen');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_get_silkscreens', '查询所有丝印文字', {}, async () => {
    const data = await bridge.command('get_silkscreens');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
