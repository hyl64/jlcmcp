/**
 * gateway-client.ts
 *
 * 官方 Bridge Server（来自 easyeda/easyeda-api-skill 的 scripts/bridge-server.mjs）
 * 的 HTTP 客户端。官方协议：
 *
 *   - GET  /health            -> { service: 'easyeda-bridge', edaConnected, ... }
 *   - GET  /eda-windows       -> { windows: [...], activeWindowId }
 *   - POST /eda-windows/select-> { windowId }
 *   - POST /execute           -> { code, windowId? } -> { success, result } | { success:false, error }
 *
 * 端口范围 49620-49629，服务标识 easyeda-bridge（握手校验）。
 * 若未发现已运行的 Bridge Server，且允许自动拉起，则 spawn 本仓库
 * scripts/bridge-server.mjs（官方单例，已在运行时会直接退出）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_PORT_START = 49620;
export const BRIDGE_PORT_END = 49629;
export const BRIDGE_SERVICE_ID = 'easyeda-bridge';

const SCAN_TIMEOUT_MS = 400;
const REQUEST_TIMEOUT_MS = 60_000;
const SPAWN_WAIT_MS = 15_000;

export interface BridgeHealth {
  service: string;
  status: string;
  edaConnected: boolean;
  edaWindowCount: number;
  activeWindowId: string | null;
  pendingRequests: number;
  timestamp: number;
}

export interface EdaWindowInfo {
  windowId: string;
  connected: boolean;
  active: boolean;
}

export interface GatewayClientOptions {
  /** 显式指定 Bridge Server 地址，如 http://127.0.0.1:49620（默认自动扫描） */
  baseUrl?: string;
  /** 未发现 Bridge Server 时是否自动拉起（默认 true） */
  autoSpawn?: boolean;
  /** bridge-server.mjs 的路径（默认 scripts/bridge-server.mjs） */
  bridgeServerPath?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function defaultBridgeServerPath(): string {
  const candidate = path.resolve(__dirname, '../scripts/bridge-server.mjs');
  return existsSync(candidate) ? candidate : path.resolve(__dirname, '../../scripts/bridge-server.mjs');
}

export class GatewayClient {
  private readonly baseUrl: string | null;
  private readonly autoSpawn: boolean;
  private readonly bridgeServerPath: string;
  private port: number | null = null;
  private child: ChildProcess | null = null;

  constructor(opts: GatewayClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.GATEWAY_BASE_URL ?? null;
    this.autoSpawn = opts.autoSpawn ?? process.env.AUTO_SPAWN_BRIDGE !== 'false';
    this.bridgeServerPath = opts.bridgeServerPath ?? process.env.BRIDGE_SERVER_PATH ?? defaultBridgeServerPath();
  }

  // ---------- 端口发现 ----------

  /** 扫描 49620-49629，返回第一个提供 easyeda-bridge 服务的端口 */
  async findBridge(): Promise<number | null> {
    for (let port = BRIDGE_PORT_START; port <= BRIDGE_PORT_END; port += 1) {
      try {
        const health = await this.httpJson('http://127.0.0.1:' + port + '/health', SCAN_TIMEOUT_MS);
        if (health && health.service === BRIDGE_SERVICE_ID) return port;
      } catch {
        // 端口无服务，继续
      }
    }
    return null;
  }

  /** 确保 Bridge Server 可用：找到或拉起，返回端口 */
  async ensureBridge(): Promise<number> {
    if (this.baseUrl) {
      const url = new URL(this.baseUrl);
      this.port = Number(url.port);
      return this.port;
    }
    if (this.port !== null) return this.port;

    const found = await this.findBridge();
    if (found !== null) {
      this.port = found;
      return found;
    }
    if (!this.autoSpawn) {
      throw new Error(
        '未发现 Bridge Server（端口 ' + BRIDGE_PORT_START + '-' + BRIDGE_PORT_END + '）。' +
        '请先运行 "npm run start:bridge"，或在嘉立创EDA中安装 Run API Gateway 扩展后重试。',
      );
    }

    await this.spawnBridgeServer();
    return this.port as unknown as number;
  }

  private async spawnBridgeServer(): Promise<void> {
    if (!existsSync(this.bridgeServerPath)) {
      throw new Error('Bridge Server 脚本不存在: ' + this.bridgeServerPath);
    }
    const child = spawn(process.execPath, [this.bridgeServerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    this.child = child;
    child.stdout?.on('data', (d) => process.stderr.write('[bridge-server] ' + d));
    child.stderr?.on('data', (d) => process.stderr.write('[bridge-server:err] ' + d));
    child.on('exit', (code) => {
      if (this.child === child) {
        this.port = null;
        this.child = null;
      }
    });

    const deadline = Date.now() + SPAWN_WAIT_MS;
    while (Date.now() < deadline) {
      const found = await this.findBridge();
      if (found !== null) {
        this.port = found;
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Bridge Server 启动超时（15s 内未就绪）');
  }

  // ---------- HTTP ----------

  private base(): string {
    if (this.baseUrl) return this.baseUrl;
    if (this.port === null) throw new Error('Bridge Server 未连接');
    return 'http://127.0.0.1:' + this.port;
  }

  private async httpJson(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<BridgeHealth> {
    await this.ensureBridge();
    return this.httpJson(this.base() + '/health');
  }

  async listWindows(): Promise<{ windows: EdaWindowInfo[]; activeWindowId: string | null; count: number }> {
    await this.ensureBridge();
    return this.httpJson(this.base() + '/eda-windows');
  }

  async selectWindow(windowId: string): Promise<{ success: boolean; activeWindowId: string }> {
    await this.ensureBridge();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.base() + '/eda-windows/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body: any = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'select failed: HTTP ' + res.status);
      }
      return (await res.json()) as { success: boolean; activeWindowId: string };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 在 EDA 内执行代码（官方 execute 协议）。返回 result；失败抛错。 */
  async execute(code: string, windowId?: string): Promise<unknown> {
    await this.ensureBridge();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.base() + '/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(windowId ? { code, windowId } : { code }),
        signal: ctrl.signal,
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        const detail = body.error ?? 'HTTP ' + res.status;
        throw new Error(
          String(detail).includes('No EDA window')
            ? 'EDA 未连接：请先在嘉立创EDA中打开工程并确认 Run API Gateway 扩展已连接（' + detail + '）'
            : detail,
        );
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 停止自拉起的 Bridge Server（若存在）。官方单例共享，默认不动它。 */
  disconnect(): void {
    if (process.env.KILL_BRIDGE_ON_EXIT === '1' && this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.child = null;
  }
}
