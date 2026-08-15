/**
 * bridge-client.ts
 *
 * 与旧版保持相同接口（command(action, params)），但底层改为官方 Bridge Server：
 *
 *   MCP 工具/Agent ── command(action, params) ──> codegen 生成 eda 代码
 *        ── POST /execute ──> 官方 Bridge Server（49620-49629）
 *        ── WS /eda ──> Run API Gateway 扩展 ──> 嘉立创EDA专业版
 *
 * 环境变量：
 *   GATEWAY_BASE_URL    显式指定 Bridge Server 地址（默认自动扫描 49620-49629）
 *   AUTO_SPAWN_BRIDGE   未发现时是否自动拉起 scripts/bridge-server.mjs（默认 true）
 *   BRIDGE_SERVER_PATH  自定义 bridge-server.mjs 路径
 *   KILL_BRIDGE_ON_EXIT 退出时是否结束自拉起的 Bridge Server（默认不结束，官方单例共享）
 */
import { GatewayClient } from './gateway-client.js';
import { actionToCode } from './codegen.js';

export class BridgeClient {
  private gw: GatewayClient;
  private connected = false;

  constructor(opts?: { baseUrl?: string; autoSpawn?: boolean; bridgeServerPath?: string }) {
    this.gw = new GatewayClient(opts ?? {});
  }

  /** 确保 Bridge Server 可用（发现或拉起）。惰性调用。 */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.gw.ensureBridge();
    this.connected = true;
  }

  /** 执行经典动作（自动 codegen → execute） */
  async command(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    const code = actionToCode(action, params);
    return this.gw.execute(code);
  }

  /** 直接执行自定义 eda 代码（高级工具用） */
  async executeRaw(code: string, windowId?: string): Promise<unknown> {
    await this.connect();
    return this.gw.execute(code, windowId);
  }

  /** 官方 Bridge Server 健康状态（含 EDA 连接数） */
  async health() {
    await this.connect();
    return this.gw.health();
  }

  async listWindows() {
    await this.connect();
    return this.gw.listWindows();
  }

  async selectWindow(windowId: string) {
    await this.connect();
    return this.gw.selectWindow(windowId);
  }

  disconnect(): void {
    this.gw.disconnect();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
