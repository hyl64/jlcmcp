import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerSchematicTools(server: any, bridge: BridgeClient) {
  server.tool('sch_get_state', '读取原理图状态', {}, async () => {
    const data = await bridge.command('get_schematic_state');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_get_netlist', '导出网表', {
    type: z.string().optional().describe('网表格式'),
  }, async ({ type }: { type?: string }) => {
    const params: Record<string, unknown> = {};
    if (type) params.type = type;
    const data = await bridge.command('get_netlist', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_run_drc', '运行原理图 DRC', {
    strict: z.boolean().optional().describe('是否严格模式'),
  }, async ({ strict }: { strict?: boolean }) => {
    const params: Record<string, unknown> = {};
    if (strict !== undefined) params.strict = strict;
    const data = await bridge.command('run_sch_drc', params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_open_document', '切换到指定文档（原理图或 PCB）', {
    uuid: z.string().describe('文档 UUID'),
  }, async ({ uuid }: { uuid: string }) => {
    const data = await bridge.command('open_document', { uuid });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
