import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerStateTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_get_state', '获取 PCB 完整状态（元件、网络、板框等）', {}, async () => {
    const data = await bridge.command('get_state');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_screenshot', '截取当前 PCB 编辑器截图', {}, async () => {
    const data = await bridge.command('screenshot') as any;
    if (data?.image) {
      return { content: [{ type: 'image' as const, data: data.image, mimeType: 'image/png' }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_run_drc', '运行 PCB 设计规则检查 (DRC)', {}, async () => {
    const data = await bridge.command('run_drc');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_get_tracks', '查询走线段', {
    net: z.string().optional().describe('网络名称（可选）'),
    layer: z.number().optional().describe('层号（可选）'),
  }, async ({ net, layer }: { net?: string; layer?: number }) => {
    const params: Record<string, unknown> = {};
    if (net !== undefined) params.net = net;
    if (layer !== undefined) params.layer = layer;
    const data = await bridge.command('get_tracks', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_get_pads', '查询焊盘信息', {
    designator: z.string().optional().describe('元件位号（可选）'),
  }, async ({ designator }: { designator?: string }) => {
    const params: Record<string, unknown> = {};
    if (designator !== undefined) params.designator = designator;
    const data = await bridge.command('get_pads', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_get_net_primitives', '查询指定网络的所有图元', {
    net: z.string().describe('网络名称'),
  }, async ({ net }: { net: string }) => {
    const data = await bridge.command('get_net_primitives', { net });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_get_board_info', '获取工程信息（板名、层数等）', {}, async () => {
    const data = await bridge.command('get_board_info');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_get_feature_support', '查询 bridge 支持的功能列表', {}, async () => {
    const data = await bridge.command('get_feature_support');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_ping', '检查 bridge 连接状态', {}, async () => {
    const data = await bridge.command('ping');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
