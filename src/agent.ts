import Anthropic from '@anthropic-ai/sdk';
import { BridgeClient } from './bridge-client.js';
import { calcImpedance, calcWidthForImpedance, calcTraceWidth, type ImpedanceType } from './calculators.js';

const SYSTEM_PROMPT = `你是嘉立创 EDA PCB 设计专家。你可以通过工具直接操控 PCB 编辑器。

## 基础信息
- 坐标系：mil（密耳），1 mil = 0.0254 mm
- 层定义：1 = 顶层 (Top), 2 = 底层 (Bottom)

## 工作流程
1. 先用 get_state 了解当前 PCB 状态
2. 分析问题，制定方案
3. 逐步执行操作
4. 用 run_drc 验证设计规则
5. 总结执行结果和建议

## USB 差分走线规范
- 差分阻抗目标 90Ω（USB 2.0）
- 用 create_differential_pair 定义差分对（如 USB_DP / USB_DN）
- 差分走线间距保持一致，推荐 6-8mil
- 差分对等长容差 ≤ 5mil，用 create_equal_length_group 管理
- 差分线远离其他信号线，间距 ≥ 3 倍线宽
- 避免过孔换层，必须换层时两根线同时换

## 晶振隔离策略
- 晶振周围创建 keepout 禁布区（create_keepout_rect），范围覆盖晶振外扩 50-100mil
- 晶振下方铺地铜（create_pour_rect），提供屏蔽
- 晶振走线尽量短，远离高速数字信号
- 晶振负载电容紧贴晶振放置
- 禁止其他信号线从晶振区域穿过

## 电源走线规范
- 充电电路和电源走线线宽 ≥ 20mil
- 大电流路径（>500mA）线宽 ≥ 30mil
- 电源走线尽量短粗直
- VCC/GND 主干线宽 ≥ 20mil
- 电源滤波电容紧贴芯片电源引脚

## 模拟电路保护
- 模拟器件（ADC、运放、传感器）与数字器件分区布局
- 模拟区域周围铺地铜做保护环
- 模拟信号走线远离数字高速信号，间距 ≥ 20mil
- 模拟地和数字地单点连接
- 模拟信号走线避免跨越分割平面

## TFT 屏走线
- 数据线建议做等长处理（create_equal_length_group）
- 等长容差 ≤ 50mil（不强求但提升性能）
- 数据线等间距走线，减少串扰

## 蜂鸣器电路
- 有源蜂鸣器：GPIO → 限流电阻 → NPN 三极管基极，集电极接蜂鸣器，发射极接地
- 蜂鸣器并联续流二极管（反向），保护三极管
- 无源蜂鸣器需要 PWM 驱动

## 注意事项
- 移动元件前先了解当前位置
- 走线前确认网络名和焊盘位置
- 批量操作时逐个执行，出错及时停止
- 所有坐标单位为 mil

## 计算工具
- 走线前用 calc_impedance 计算目标阻抗对应的线宽
- USB 差分对：calc_impedance type=diff_microstrip, targetImpedance=90
- 电源走线：calc_trace_width 确认线宽满足载流要求`;

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
      name: 'delete_differential_pair', description: '删除差分对',
      input_schema: {
        type: 'object', properties: {
          name: { type: 'string', description: '差分对名称' },
        }, required: ['name'],
      },
      execute: async (p) => bridge.command('delete_differential_pair', p),
    },
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
    {
      name: 'delete_equal_length_group', description: '删除等长组',
      input_schema: {
        type: 'object', properties: {
          name: { type: 'string', description: '等长组名称' },
        }, required: ['name'],
      },
      execute: async (p) => bridge.command('delete_equal_length_group', p),
    },

    // --- 元件选择/放置 ---
    {
      name: 'select_component', description: '在编辑器中选中元件',
      input_schema: {
        type: 'object', properties: {
          designator: { type: 'string', description: '元件位号' },
        }, required: ['designator'],
      },
      execute: async (p) => bridge.command('select_component', p),
    },
    simple('delete_selected', 'delete_selected', '删除当前选中的对象'),
    {
      name: 'create_pcb_component', description: '从库中放置元件到 PCB',
      input_schema: {
        type: 'object', properties: {
          component: { type: 'object', properties: { libraryUuid: { type: 'string' }, uuid: { type: 'string' } }, required: ['libraryUuid', 'uuid'] },
          layer: { type: 'number', description: '层号' },
          x: { type: 'number' }, y: { type: 'number' },
          rotation: { type: 'number', description: '旋转角度（可选）' },
        }, required: ['component', 'layer', 'x', 'y'],
      },
      execute: async (p) => bridge.command('create_pcb_component', p),
    },

    // --- 文档/系统 ---
    {
      name: 'open_document', description: '切换到指定文档（原理图或 PCB）',
      input_schema: {
        type: 'object', properties: {
          uuid: { type: 'string', description: '文档 UUID' },
        }, required: ['uuid'],
      },
      execute: async (p) => bridge.command('open_document', p),
    },
    simple('get_feature_support', 'get_feature_support', '查询 bridge 支持的功能列表'),
    simple('ping', 'ping', '检查 bridge 连接状态'),

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

    // --- 计算工具（纯数学，不走 bridge）---
    {
      name: 'calc_impedance', description: '计算走线阻抗或根据目标阻抗反算线宽',
      input_schema: {
        type: 'object', properties: {
          type: { type: 'string', enum: ['microstrip', 'stripline', 'diff_microstrip', 'diff_stripline'], description: '走线类型' },
          width: { type: 'number', description: '线宽 (mil)，与 targetImpedance 二选一' },
          targetImpedance: { type: 'number', description: '目标阻抗 (Ω)，填此项则反算线宽' },
          thickness: { type: 'number', description: '铜厚 (mil)，默认 1.4' },
          height: { type: 'number', description: '介质厚度 (mil)' },
          er: { type: 'number', description: '介电常数，默认 4.3' },
          spacing: { type: 'number', description: '差分间距 (mil)，差分模式必填' },
        }, required: ['type', 'height'],
      },
      execute: async (p) => {
        if (p.targetImpedance !== undefined) {
          return calcWidthForImpedance({
            type: p.type as ImpedanceType,
            targetImpedance: p.targetImpedance as number,
            thickness: p.thickness as number | undefined,
            height: p.height as number,
            er: p.er as number | undefined,
            spacing: p.spacing as number | undefined,
          });
        }
        return calcImpedance({
          type: p.type as ImpedanceType,
          width: p.width as number,
          thickness: p.thickness as number | undefined,
          height: p.height as number,
          er: p.er as number | undefined,
          spacing: p.spacing as number | undefined,
        });
      },
    },
    {
      name: 'calc_trace_width', description: '根据载流要求计算最小走线宽度 (IPC-2221)',
      input_schema: {
        type: 'object', properties: {
          current: { type: 'number', description: '电流 (A)' },
          thickness: { type: 'number', description: '铜厚 (mil)，默认 1.4' },
          tempRise: { type: 'number', description: '允许温升 (°C)，默认 10' },
          layer: { type: 'string', enum: ['external', 'internal'], description: '走线层类型，默认 external' },
        }, required: ['current'],
      },
      execute: async (p) => calcTraceWidth({
        current: p.current as number,
        thickness: p.thickness as number | undefined,
        tempRise: p.tempRise as number | undefined,
        layer: (p.layer as 'external' | 'internal') ?? 'external',
      }),
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
