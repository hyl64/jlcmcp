/**
 * tools/gateway.ts — 官方 Bridge Server 运维工具
 */
import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';

export function registerGatewayTools(server: any, bridge: BridgeClient) {
  server.tool(
    'pcb_bridge_status',
    '查看官方 Bridge Server 连接状态（服务标识、EDA 窗口连接数、当前活动窗口）',
    {},
    async () => {
      try {
        const health = await bridge.health();
        const windows = await bridge.listWindows();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ health, windows }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: 'Bridge 未就绪: ' + e.message }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'pcb_list_eda_windows',
    '列出所有已连接嘉立创EDA窗口及其活动状态',
    {},
    async () => {
      const windows = await bridge.listWindows();
      return { content: [{ type: 'text' as const, text: JSON.stringify(windows, null, 2) }] };
    },
  );

  server.tool(
    'pcb_select_eda_window',
    '选择当前活动的嘉立创EDA窗口（多开时指定执行目标）',
    {
      windowId: z.string().describe('窗口 ID（来自 pcb_list_eda_windows）'),
    },
    async ({ windowId }: { windowId: string }) => {
      const data = await bridge.selectWindow(windowId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'pcb_execute_code',
    '在嘉立创EDA专业版内直接执行 JavaScript 代码（高级/调试用）。代码运行于扩展环境，eda 为官方扩展 API。示例：return await eda.dmt_Project.getCurrentProjectInfo();',
    {
      code: z.string().describe('要执行的 JavaScript 代码（支持 await，以 return 返回结果）'),
      windowId: z.string().optional().describe('目标 EDA 窗口 ID（可选，默认活动窗口）'),
    },
    async ({ code, windowId }: { code: string; windowId?: string }) => {
      const data = await bridge.executeRaw(code, windowId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    },
  );
}
