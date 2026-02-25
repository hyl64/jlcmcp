import Anthropic from '@anthropic-ai/sdk';
import { BridgeClient } from './bridge-client.js';

const SYSTEM_PROMPT = `你是嘉立创 EDA PCB 设计专家。你可以通过工具直接操控 PCB 编辑器。

坐标系：mil（密耳），1 mil = 0.0254 mm
层定义：1 = 顶层 (Top), 2 = 底层 (Bottom)

工作流程：
1. 先用 get_state 了解当前 PCB 状态
2. 分析问题，制定方案
3. 逐步执行操作
4. 用 run_drc 验证设计规则
5. 总结执行结果和建议

注意事项：
- 移动元件前先了解当前位置
- 走线前确认网络名和焊盘位置
- 批量操作时逐个执行，出错及时停止
- 所有坐标单位为 mil`;

interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

interface StepLog {
  step: number;
  tool: string;
  input: Record<string, unknown>;
  output: unknown;
  durationMs: number;
}

function buildToolRegistry(bridge: BridgeClient): AgentTool[] {
  const simple = (name: string, action: string, description: string) => ({
    name, description,
    input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
    execute: async () => bridge.command(action),
  });

  return [
    // --- 状态查询 ---
    simple('get_state', 'get_state', '获取 PCB 完整状态（元件、网络、板框等）'),
    simple('screenshot', 'screenshot', '截取当前 PCB 编辑器截图'),
    simple('run_drc', 'run_drc', '运行 PCB 设计规则检查'),
    {
      name: 'get_tracks', description: '查询走线段',
      input_schema: {
        type: 'object', properties: {
          net: { type: 'string', description: '网络名称（可选）' },
          layer: { type: 'number', description: '层号（可选）' },
        }, required: [],
      },
      execute: async (p) => bridge.command('get_tracks', p),
    },
    {
      name: 'get_pads', description: '查询焊盘信息',
      input_schema: {
        type: 'object', properties: {
          designator: { type: 'string', description: '元件位号（可选）' },
        }, required: [],
      },
      execute: async (p) => bridge.command('get_pads', p),
    },
    {
      name: 'get_net_primitives', description: '查询指定网络的所有图元',
      input_schema: {
        type: 'object', properties: {
          net: { type: 'string', description: '网络名称' },
        }, required: ['net'],
      },
      execute: async (p) => bridge.command('get_net_primitives', p),
    },
    simple('get_board_info', 'get_board_info', '获取工程信息（板名、层数等）'),
    simple('get_silkscreens', 'get_silkscreens', '查询所有丝印文字'),

    // --- 元件操作 ---
    {
      name: 'move_component', description: '移动元件到指定坐标 (mil)',
      input_schema: {
        type: 'object', properties: {
          designator: { type: 'string', description: '元件位号，如 U1, R1' },
          x: { type: 'number', description: 'X 坐标 (mil)' },
          y: { type: 'number', description: 'Y 坐标 (mil)' },
          rotation: { type: 'number', description: '旋转角度（可选）' },
        }, required: ['designator', 'x', 'y'],
      },
      execute: async (p) => bridge.command('move_component', p),
    },
    {
      name: 'relocate_component', description: '安全搬迁元件（自动断开走线）',
      input_schema: {
        type: 'object', properties: {
          designator: { type: 'string', description: '元件位号' },
          x: { type: 'number', description: 'X 坐标 (mil)' },
          y: { type: 'number', description: 'Y 坐标 (mil)' },
          rotation: { type: 'number', description: '旋转角度（可选）' },
        }, required: ['designator', 'x', 'y'],
      },
      execute: async (p) => bridge.command('relocate_component', p),
    },

    // --- 走线 / 过孔 ---
    {
      name: 'route_track', description: '画走线',
      input_schema: {
        type: 'object', properties: {
          net: { type: 'string', description: '网络名称' },
          points: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }, description: '走线路径点 (mil)' },
          layer: { type: 'number', description: '层号 (1=顶层, 2=底层)' },
          width: { type: 'number', description: '线宽 (mil)' },
        }, required: ['net', 'points', 'layer', 'width'],
      },
      execute: async (p) => bridge.command('route_track', p),
    },
    {
      name: 'create_via', description: '创建过孔',
      input_schema: {
        type: 'object', properties: {
          net: { type: 'string', description: '网络名称' },
          x: { type: 'number', description: 'X 坐标 (mil)' },
          y: { type: 'number', description: 'Y 坐标 (mil)' },
          drill: { type: 'number', description: '钻孔直径 (mil)' },
          diameter: { type: 'number', description: '过孔外径 (mil)' },
        }, required: ['net', 'x', 'y', 'drill', 'diameter'],
      },
      execute: async (p) => bridge.command('create_via', p),
    },
    {
      name: 'delete_tracks', description: '删除走线',
      input_schema: {
        type: 'object', properties: {
          primitiveIds: { type: 'array', items: { type: 'string' }, description: '走线图元 ID 列表' },
        }, required: ['primitiveIds'],
      },
      execute: async (p) => bridge.command('delete_tracks', p),
    },
    {
      name: 'delete_via', description: '删除过孔',
      input_schema: {
        type: 'object', properties: {
          primitiveIds: { type: 'array', items: { type: 'string' }, description: '过孔图元 ID 列表' },
        }, required: ['primitiveIds'],
      },
      execute: async (p) => bridge.command('delete_via', p),
    },
    // --- 铺铜 / 禁布区 ---
    {
      name: 'create_pour_rect', description: '创建矩形铺铜区域',
      input_schema: {
        type: 'object', properties: {
          net: { type: 'string', description: '网络名称（如 GND）' },
          layer: { type: 'number', description: '层号' },
          x1: { type: 'number' }, y1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' },
        }, required: ['net', 'layer', 'x1', 'y1', 'x2', 'y2'],
      },
      execute: async (p) => bridge.command('create_pour_rect', p),
    },
    {
      name: 'delete_pour', description: '删除铺铜',
      input_schema: {
        type: 'object', properties: {
          primitiveId: { type: 'string', description: '铺铜图元 ID' },
        }, required: ['primitiveId'],
      },
      execute: async (p) => bridge.command('delete_pour', p),
    },
    {
      name: 'create_keepout_rect', description: '创建矩形禁布区',
      input_schema: {
        type: 'object', properties: {
          x1: { type: 'number' }, y1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' },
          layer: { type: 'number', description: '层号（不填则所有层）' },
        }, required: ['x1', 'y1', 'x2', 'y2'],
      },
      execute: async (p) => bridge.command('create_keepout_rect', p),
    },
    {
      name: 'delete_region', description: '删除禁布区',
      input_schema: {
        type: 'object', properties: {
          primitiveId: { type: 'string', description: '禁布区图元 ID' },
        }, required: ['primitiveId'],
      },
      execute: async (p) => bridge.command('delete_region', p),
    },

    // --- 丝印 ---
    {
      name: 'move_silkscreen', description: '移动丝印文字',
      input_schema: {
        type: 'object', properties: {
          primitiveId: { type: 'string', description: '丝印图元 ID' },
          x: { type: 'number' }, y: { type: 'number' },
          rotation: { type: 'number', description: '旋转角度（可选）' },
        }, required: ['primitiveId', 'x', 'y'],
      },
      execute: async (p) => bridge.command('move_silkscreen', p),
    },
    simple('auto_silkscreen', 'auto_silkscreen', '自动排列所有丝印（避免重叠）'),

    // --- 差分对 / 等长组 ---
    {
      name: 'create_differential_pair', description: '创建差分对',
      input_schema: {
        type: 'object', properties: {
          name: { type: 'string', description: '差分对名称' },
          posNet: { type: 'string', description: '正极网络名' },
          negNet: { type: 'string', description: '负极网络名' },
        }, required: ['name', 'posNet', 'negNet'],
      },
      execute: async (p) => bridge.command('create_differential_pair', p),
    },
    simple('list_differential_pairs', 'list_differential_pairs', '列出所有差分对'),
    {
      name: 'create_equal_length_group', description: '创建等长组',
      input_schema: {
        type: 'object', properties: {
          name: { type: 'string', description: '等长组名称' },
          nets: { type: 'array', items: { type: 'string' }, description: '网络名称列表' },
        }, required: ['name', 'nets'],
      },
      execute: async (p) => bridge.command('create_equal_length_group', p),
    },
    simple('list_equal_length_groups', 'list_equal_length_groups', '列出所有等长组'),

    // --- 原理图 ---
    simple('get_schematic_state', 'get_schematic_state', '读取原理图状态'),
    {
      name: 'get_netlist', description: '导出网表',
      input_schema: {
        type: 'object', properties: {
          type: { type: 'string', description: '网表格式（可选）' },
        }, required: [],
      },
      execute: async (p) => bridge.command('get_netlist', p),
    },
    {
      name: 'run_sch_drc', description: '运行原理图 DRC',
      input_schema: {
        type: 'object', properties: {
          strict: { type: 'boolean', description: '是否严格模式' },
        }, required: [],
      },
      execute: async (p) => bridge.command('run_sch_drc', p),
    },
  ];
}

export interface AgentResult {
  finalAnswer: string;
  steps: StepLog[];
  totalTurns: number;
}

export async function runAgent(
  bridge: BridgeClient,
  task: string,
  maxTurns = 20,
): Promise<AgentResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is required');

  const model = process.env.AGENT_MODEL ?? 'claude-sonnet-4-20250514';
  const client = new Anthropic({ apiKey });
  const tools = buildToolRegistry(bridge);

  const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: task },
  ];

  const steps: StepLog[] = [];
  let turn = 0;

  while (turn < maxTurns) {
    turn++;

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });

    // Collect tool_use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ContentBlockParam & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        b.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      // No tool calls — extract final text answer
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      const finalAnswer = textBlocks.map((b) => b.text).join('\n') || '(agent completed without text output)';
      return { finalAnswer, steps, totalTurns: turn };
    }

    // Append assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool call and build results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      const tool = toolMap.get(block.name);
      const stepStart = Date.now();
      let output: unknown;
      let isError = false;

      if (!tool) {
        output = `Unknown tool: ${block.name}`;
        isError = true;
      } else {
        try {
          output = await tool.execute(block.input);
        } catch (e: any) {
          output = e.message ?? String(e);
          isError = true;
        }
      }

      const durationMs = Date.now() - stepStart;
      steps.push({ step: steps.length + 1, tool: block.name, input: block.input, output, durationMs });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
        is_error: isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Max turns reached
  const finalAnswer = `Agent 达到最大轮次限制 (${maxTurns})。已执行 ${steps.length} 步操作。`;
  return { finalAnswer, steps, totalTurns: turn };
}
