import WebSocket from 'ws';
import { randomUUID } from 'crypto';

const COMMAND_TIMEOUT_MS = 60_000;
const RECONNECT_DELAY_MS = 3_000;

interface BridgeCommand {
  type: 'command';
  id: string;
  timestamp: number;
  payload: { action: string; params: Record<string, unknown> };
}

interface BridgeResult {
  type: 'result';
  id: string;
  timestamp: number;
  payload: {
    commandId: string;
    success: boolean;
    data?: unknown;
    error?: string;
    durationMs: number;
  };
}

type PendingResolve = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private pending = new Map<string, PendingResolve>();
  private connected = false;
  private shouldReconnect = true;

  constructor(url?: string) {
    this.url = url ?? process.env.GATEWAY_WS_URL ?? 'ws://127.0.0.1:18800/ws/bridge';
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.on('open', () => {
        this.ws = ws;
        this.connected = true;
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw.toString()));
      ws.on('close', () => this.handleClose());
      ws.on('error', (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as BridgeResult;
      if (msg.type === 'result' && msg.payload?.commandId) {
        const p = this.pending.get(msg.payload.commandId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.payload.commandId);
          if (msg.payload.success) {
            p.resolve(msg.payload.data);
          } else {
            p.reject(new Error(msg.payload.error ?? 'Bridge command failed'));
          }
        }
      }
    } catch { /* ignore non-JSON */ }
  }

  private handleClose(): void {
    this.connected = false;
    this.ws = null;
    // Reject all pending commands
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('WebSocket disconnected'));
    }
    this.pending.clear();
    if (this.shouldReconnect) {
      setTimeout(() => this.connect().catch(() => {}), RECONNECT_DELAY_MS);
    }
  }

  async command(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || !this.connected) {
      await this.connect();
    }
    const id = randomUUID();
    const cmd: BridgeCommand = {
      type: 'command',
      id,
      timestamp: Date.now(),
      payload: { action, params },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge command '${action}' timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(cmd));
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
