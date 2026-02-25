import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';
import { runAgent } from '../agent.js';

export function registerAgentTools(server: any, bridge: BridgeClient) {
  // Only register if ANTHROPIC_API_KEY is available
  if (!process.env.ANTHROPIC_API_KEY) return;

  server.tool(
    'pcb_agent',
    '智能 PCB Agent — 给出高层任务描述，自主编排多个工具完成复杂 PCB 操作（如"分析布局并优化"、"检查所有网络连通性"）',
    {
      task: z.string().describe('任务描述（自然语言），如"分析当前布局并给出优化建议"'),
      max_turns: z.number().optional().describe('最大推理轮次（默认 20）'),
    },
    async ({ task, max_turns }: { task: string; max_turns?: number }) => {
      try {
        const result = await runAgent(bridge, task, max_turns ?? 20);

        const stepsSummary = result.steps
          .map((s) => `  [${s.step}] ${s.tool}(${JSON.stringify(s.input)}) → ${s.durationMs}ms`)
          .join('\n');

        const output = [
          `=== Agent 执行完成 (${result.totalTurns} 轮, ${result.steps.length} 步) ===\n`,
          result.finalAnswer,
          result.steps.length > 0 ? `\n--- 执行步骤 ---\n${stepsSummary}` : '',
        ].join('\n');

        return { content: [{ type: 'text' as const, text: output }] };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `Agent 执行失败: ${e.message}` }],
          isError: true,
        };
      }
    },
  );
}
