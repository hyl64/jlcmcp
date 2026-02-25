# jlceda-mcp-server

嘉立创 EDA MCP Server — 让 Claude Code 直接操控嘉立创 EDA 的 PCB 自动化助手。

通过 [Model Context Protocol](https://modelcontextprotocol.io/) 暴露 32 个 PCB/原理图工具，Claude Code 可以在对话中直接执行元件移动、走线、铺铜、DRC、自动布局布线等操作。

## 架构

```
Claude Code ──stdio──> jlceda-mcp-server
                           │
                           ├─ WebSocket ws://127.0.0.1:18800/ws/bridge
                           │     → jlc-bridge 插件 → 嘉立创 EDA
                           │
                           ├─ HTTP → placement-service :18810
                           │     (DREAMPlace / RL_PCB 自动布局)
                           │
                           ├─ HTTP → routing-service :18820
                           │     (Freerouting 自动布线)
                           │
                           └─ HTTP → format-converter :18840
                                 (IR ↔ JLC/KiCad/LEF_DEF/DSN)
```

MCP server 通过 stdio 与 Claude Code 通信，内部管理 WebSocket 连接到 gateway bridge 控制 EDA 编辑器，同时直接 HTTP 调用各后端服务。

## 前置条件

- Node.js >= 18
- gateway 运行中（端口 18800），jlc-bridge 插件已连接嘉立创 EDA
- （可选）placement-service、routing-service、format-converter 运行中

## 安装 & 构建

```bash
cd jlceda-mcp-server
npm install
npm run build
```

## 配置 Claude Code

在项目根目录 `D:\jlcextention\.mcp.json`（已创建）：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "node",
      "args": ["D:/jlcextention/jlceda-mcp-server/dist/index.js"],
      "env": {
        "GATEWAY_WS_URL": "ws://127.0.0.1:18800/ws/bridge",
        "PLACEMENT_URL": "http://127.0.0.1:18810",
        "ROUTING_URL": "http://127.0.0.1:18820",
        "CONVERTER_URL": "http://127.0.0.1:18840"
      }
    }
  }
}
```

配置完成后重启 Claude Code，即可在对话中使用所有 PCB 工具。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18800/ws/bridge` | Gateway WebSocket 地址 |
| `PLACEMENT_URL` | `http://127.0.0.1:18810` | 布局服务地址 |
| `ROUTING_URL` | `http://127.0.0.1:18820` | 布线服务地址 |
| `CONVERTER_URL` | `http://127.0.0.1:18840` | 格式转换服务地址 |

## 工具清单 (32 个)

### 状态查询

| 工具 | 说明 |
|------|------|
| `pcb_get_state` | 获取 PCB 完整状态（元件、网络、板框） |
| `pcb_screenshot` | 截取编辑器截图（base64 PNG） |
| `pcb_run_drc` | 运行 PCB 设计规则检查 |
| `pcb_get_tracks` | 查询走线段，可按网络/层过滤 |
| `pcb_get_pads` | 查询焊盘信息，可按位号过滤 |
| `pcb_get_net_primitives` | 查询指定网络的所有图元 |
| `pcb_get_board_info` | 获取工程信息 |

### 元件操作

| 工具 | 说明 |
|------|------|
| `pcb_move_component` | 移动元件到指定坐标 |
| `pcb_relocate_component` | 安全搬迁元件（自动断开走线） |
| `pcb_batch_move` | 批量移动多个元件 |

### 走线 / 过孔

| 工具 | 说明 |
|------|------|
| `pcb_route_track` | 画走线（指定网络、路径点、层、线宽） |
| `pcb_create_via` | 创建过孔 |
| `pcb_delete_tracks` | 删除走线 |
| `pcb_delete_via` | 删除过孔 |

### 铺铜 / 禁布区

| 工具 | 说明 |
|------|------|
| `pcb_create_copper_pour` | 创建矩形铺铜区域 |
| `pcb_delete_pour` | 删除铺铜 |
| `pcb_create_keepout` | 创建矩形禁布区 |
| `pcb_delete_keepout` | 删除禁布区 |

### 丝印

| 工具 | 说明 |
|------|------|
| `pcb_get_silkscreens` | 查询所有丝印文字 |
| `pcb_move_silkscreen` | 移动丝印 |
| `pcb_auto_silkscreen` | 自动排列丝印（避免重叠） |

### 高级约束

| 工具 | 说明 |
|------|------|
| `pcb_create_diff_pair` | 创建差分对 |
| `pcb_list_diff_pairs` | 列出所有差分对 |
| `pcb_create_equal_length` | 创建等长组 |
| `pcb_list_equal_lengths` | 列出所有等长组 |

### 原理图

| 工具 | 说明 |
|------|------|
| `sch_get_state` | 读取原理图状态 |
| `sch_get_netlist` | 导出网表 |
| `sch_run_drc` | 运行原理图 DRC |

### 引擎服务

| 工具 | 说明 |
|------|------|
| `service_auto_place` | 调用 DREAMPlace/RL_PCB 自动布局，自动 IR 转换并写回 EDA |
| `service_auto_route` | 调用 Freerouting 自动布线，结果自动写回 EDA |
| `service_convert` | 格式转换（IR ↔ JLC/KiCad/LEF_DEF/DSN/SES） |
| `service_health` | 检查所有后端服务状态 |

> 所有坐标参数单位为 **mil**（密耳），与嘉立创 EDA bridge 一致。`service_auto_place` 和 `service_auto_route` 内部自动处理 mil ↔ mm 的 IR 转换。

## 项目结构

```
jlceda-mcp-server/
├── src/
│   ├── index.ts              # MCP 入口（stdio transport）
│   ├── bridge-client.ts      # WebSocket 客户端，连接 gateway bridge
│   ├── service-client.ts     # HTTP 客户端，调用后端服务
│   └── tools/
│       ├── state.ts          # 状态查询类工具 (7)
│       ├── components.ts     # 元件操作类工具 (3)
│       ├── routing.ts        # 走线/过孔类工具 (4)
│       ├── copper-keepout.ts # 铺铜/禁布区类工具 (4)
│       ├── silkscreen.ts     # 丝印类工具 (3)
│       ├── advanced.ts       # 差分对/等长组 (4)
│       ├── schematic.ts      # 原理图/跨文档 (3)
│       └── services.ts       # 引擎布局/布线/格式转换 (4)
├── dist/                     # 编译输出
├── package.json
└── tsconfig.json
```

## 核心模块说明

### bridge-client.ts

WebSocket 客户端，连接 `ws://127.0.0.1:18800/ws/bridge`。

- 发送 `{type:'command', id, timestamp, payload:{action, params}}`
- 接收 `{type:'result', payload:{commandId, success, data, error}}`
- 命令超时 60 秒
- 断线自动重连（3 秒间隔）
- 懒连接：首次调用 `command()` 时才建立 WebSocket

### service-client.ts

HTTP 客户端，直接调用各后端服务 REST API。

- `place(irData, engine, options)` → POST `:18810/place`
- `route(irData, options)` → POST `:18820/route`
- `convert(data, from, to)` → POST `:18840/convert`
- `healthAll()` → 并行 GET 各服务 `/health`

### tools/services.ts 中的 IR 转换

`service_auto_place` 和 `service_auto_route` 内置了 BridgeState → PcbIR 的转换逻辑：

1. 通过 bridge `get_state` 获取当前 PCB 状态（mil 坐标）
2. 转换为 PcbIR 格式（mm 坐标，KiCad 层名）
3. 调用后端服务
4. 将结果逐个写回 EDA（mm → mil 反转换，逐个 `move_component` / `route_track` / `create_via`）

## 使用示例

在 Claude Code 中直接用自然语言：

```
> 获取当前 PCB 状态
  → 调用 pcb_get_state

> 把 U1 移到 (1000, 2000)
  → 调用 pcb_move_component {designator:"U1", x:1000, y:2000}

> 运行 DRC 检查
  → 调用 pcb_run_drc

> 自动布局
  → 调用 service_auto_place {engine:"auto"}

> 在 GND 网络顶层铺铜，范围 (0,0) 到 (2000,4000)
  → 调用 pcb_create_copper_pour {net:"GND", layer:1, x1:0, y1:0, x2:2000, y2:4000}

> 检查所有后端服务是否正常
  → 调用 service_health
```

## 验证

```bash
# 编译
npm run build

# 测试 MCP 协议（不需要 gateway）
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":0}
{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js

# 端到端测试（需要 gateway + jlc-bridge 运行）
# 在 Claude Code 中说 "获取当前 PCB 状态" 即可验证
```

## 技术栈

- TypeScript 5.7, ES2022 modules
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) ^1.12 — MCP 协议实现
- [ws](https://www.npmjs.com/package/ws) ^8 — WebSocket 客户端
- [zod](https://www.npmjs.com/package/zod) ^3.23 — 工具参数 schema 定义
