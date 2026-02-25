# jlceda-mcp-server

嘉立创 EDA MCP Server — 让 AI 编程助手直接操控嘉立创 EDA 的 PCB 自动化工具集。

通过 [Model Context Protocol](https://modelcontextprotocol.io/) 暴露 28 个 PCB/原理图工具，在 Claude Code / Cursor / Windsurf 等 AI IDE 中直接执行元件移动、走线、铺铜、DRC 等操作。

## 架构

```
AI IDE ──stdio──> jlceda-mcp-server ──WebSocket──> gateway ──> jlc-bridge 插件 ──> 嘉立创 EDA
```

MCP server 通过 stdio 与 AI IDE 通信，内部维护 WebSocket 连接到 gateway 的 `/ws/bridge` 端点，转发命令给 jlc-bridge 插件控制 EDA 编辑器。

## 前置条件

- Node.js >= 18
- gateway 运行中（默认端口 18800）
- jlc-bridge 插件已连接嘉立创 EDA

## 安装 & 构建

```bash
npm install
npm run build
```

## 配置

在你的项目目录下创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "node",
      "args": ["<path-to>/jlceda-mcp-server/dist/index.js"],
      "env": {
        "GATEWAY_WS_URL": "ws://127.0.0.1:18800/ws/bridge"
      }
    }
  }
}
```

配置完成后重启 AI IDE，即可在对话中使用所有工具。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18800/ws/bridge` | Gateway WebSocket 地址 |

## 工具清单 (28 个)

### 状态查询 (7)

| 工具 | 说明 |
|------|------|
| `pcb_get_state` | 获取 PCB 完整状态（元件、网络、板框） |
| `pcb_screenshot` | 截取编辑器截图（base64 PNG） |
| `pcb_run_drc` | 运行 PCB 设计规则检查 |
| `pcb_get_tracks` | 查询走线段，可按网络/层过滤 |
| `pcb_get_pads` | 查询焊盘信息，可按位号过滤 |
| `pcb_get_net_primitives` | 查询指定网络的所有图元 |
| `pcb_get_board_info` | 获取工程信息 |

### 元件操作 (3)

| 工具 | 说明 |
|------|------|
| `pcb_move_component` | 移动元件到指定坐标 |
| `pcb_relocate_component` | 安全搬迁元件（自动断开走线） |
| `pcb_batch_move` | 批量移动多个元件 |

### 走线 / 过孔 (4)

| 工具 | 说明 |
|------|------|
| `pcb_route_track` | 画走线（指定网络、路径点、层、线宽） |
| `pcb_create_via` | 创建过孔 |
| `pcb_delete_tracks` | 删除走线 |
| `pcb_delete_via` | 删除过孔 |

### 铺铜 / 禁布区 (4)

| 工具 | 说明 |
|------|------|
| `pcb_create_copper_pour` | 创建矩形铺铜区域 |
| `pcb_delete_pour` | 删除铺铜 |
| `pcb_create_keepout` | 创建矩形禁布区 |
| `pcb_delete_keepout` | 删除禁布区 |

### 丝印 (3)

| 工具 | 说明 |
|------|------|
| `pcb_get_silkscreens` | 查询所有丝印文字 |
| `pcb_move_silkscreen` | 移动丝印 |
| `pcb_auto_silkscreen` | 自动排列丝印（避免重叠） |

### 高级约束 (4)

| 工具 | 说明 |
|------|------|
| `pcb_create_diff_pair` | 创建差分对 |
| `pcb_list_diff_pairs` | 列出所有差分对 |
| `pcb_create_equal_length` | 创建等长组 |
| `pcb_list_equal_lengths` | 列出所有等长组 |

### 原理图 (3)

| 工具 | 说明 |
|------|------|
| `sch_get_state` | 读取原理图状态 |
| `sch_get_netlist` | 导出网表 |
| `sch_run_drc` | 运行原理图 DRC |

> 所有坐标参数单位为 **mil**（密耳），与嘉立创 EDA bridge 一致。

## 项目结构

```
jlceda-mcp-server/
├── src/
│   ├── index.ts              # MCP 入口（stdio transport）
│   ├── bridge-client.ts      # WebSocket 客户端，连接 gateway bridge
│   └── tools/
│       ├── state.ts          # 状态查询 (7)
│       ├── components.ts     # 元件操作 (3)
│       ├── routing.ts        # 走线/过孔 (4)
│       ├── copper-keepout.ts # 铺铜/禁布区 (4)
│       ├── silkscreen.ts     # 丝印 (3)
│       ├── advanced.ts       # 差分对/等长组 (4)
│       └── schematic.ts      # 原理图 (3)
├── dist/                     # 编译输出
├── package.json
└── tsconfig.json
```

## 核心模块

### bridge-client.ts

WebSocket 客户端，连接 gateway `/ws/bridge`。

- 协议：发送 `{type:'command', id, timestamp, payload:{action, params}}`，接收 `{type:'result', payload:{commandId, success, data, error}}`
- 命令超时 60 秒
- 断线自动重连（3 秒间隔）
- 懒连接：首次调用 `command()` 时才建立 WebSocket

## 使用示例

在 AI IDE 中直接用自然语言：

```
> 获取当前 PCB 状态
  → 调用 pcb_get_state

> 把 U1 移到 (1000, 2000)
  → 调用 pcb_move_component {designator:"U1", x:1000, y:2000}

> 运行 DRC 检查
  → 调用 pcb_run_drc

> 在 GND 网络顶层铺铜，范围 (0,0) 到 (2000,4000)
  → 调用 pcb_create_copper_pour {net:"GND", layer:1, x1:0, y1:0, x2:2000, y2:4000}

> 创建 USB 差分对
  → 调用 pcb_create_diff_pair {name:"USB", posNet:"USB_DP", negNet:"USB_DN"}
```

## 验证

```bash
# 编译
npm run build

# 测试 MCP 协议（不需要 gateway）
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}},"id":0}
{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js

# 端到端测试（需要 gateway + jlc-bridge 运行）
# 在 AI IDE 中说 "获取当前 PCB 状态" 即可验证
```

## 技术栈

- TypeScript 5.7, ES2022 modules
- [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) ^1.12 — MCP 协议实现
- [ws](https://www.npmjs.com/package/ws) ^8 — WebSocket 客户端
- [zod](https://www.npmjs.com/package/zod) ^3.23 — 工具参数 schema 定义

## License

MIT
