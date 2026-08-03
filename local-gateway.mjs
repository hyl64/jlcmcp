import { WebSocketServer } from 'ws';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const port = Number(process.env.JLCEDA_GATEWAY_PORT || 18800);
const path = process.env.JLCEDA_GATEWAY_PATH || '/ws/bridge';
const bridgeDir = process.env.JLCEDA_FILE_BRIDGE_DIR || resolve(process.cwd(), '.jlc-bridge');
const commandFile = join(bridgeDir, 'command.json');
const resultFile = join(bridgeDir, 'result.json');

const wss = new WebSocketServer({ port, path });
const clients = new Set();
const wsEdaClients = new Set();

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(message);
  }
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.error(`[gateway] connected ${peer}, clients=${clients.size}`);

  ws.on('message', (data) => {
    const message = data.toString();
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      parsed = null;
    }

    if (parsed?.type === 'hello') {
      wsEdaClients.add(ws);
      console.error(`[gateway] EDA bridge hello ${parsed.name || ''} ${parsed.version || ''}`);
    }

    if (parsed?.type === 'command' && wsEdaClients.size === 0) {
      void handleFileCommand(ws, parsed);
      return;
    }

    for (const client of clients) {
      if (client !== ws) send(client, message);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    wsEdaClients.delete(ws);
    console.error(`[gateway] disconnected ${peer}, clients=${clients.size}`);
  });

  ws.on('error', (error) => {
    console.error(`[gateway] client error ${peer}: ${error.message}`);
  });
});

async function handleFileCommand(ws, msg) {
  const commandId = msg.id;
  const action = msg.action ?? msg.payload?.action;
  const params = msg.params ?? msg.payload?.params ?? {};
  if (!commandId || !action) return;

  try {
    await mkdir(bridgeDir, { recursive: true });
    await writeFile(resultFile, '', 'utf8').catch(() => {});
    await writeFile(commandFile, JSON.stringify({
      id: commandId,
      action,
      params,
      timestamp: Date.now(),
    }, null, 2), 'utf8');

    const started = Date.now();
    const timeoutMs = 60000;
    while (Date.now() - started < timeoutMs) {
      await sleep(250);
      const raw = await readFile(resultFile, 'utf8').catch(() => '');
      if (!raw.trim()) continue;

      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        continue;
      }
      if (result?.id !== commandId) continue;

      send(ws, JSON.stringify({
        type: 'result',
        id: commandId,
        timestamp: Date.now(),
        payload: {
          commandId,
          success: Boolean(result.success),
          data: result.data,
          error: result.error,
          durationMs: result.durationMs,
        },
      }));
      return;
    }

    send(ws, JSON.stringify({
      type: 'result',
      id: commandId,
      timestamp: Date.now(),
      payload: {
        commandId,
        success: false,
        error: `file bridge command '${action}' timed out`,
        durationMs: timeoutMs,
      },
    }));
  } catch (error) {
    send(ws, JSON.stringify({
      type: 'result',
      id: commandId,
      timestamp: Date.now(),
      payload: {
        commandId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      },
    }));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

wss.on('listening', () => {
  console.error(`[gateway] listening ws://127.0.0.1:${port}${path}`);
});

wss.on('error', (error) => {
  console.error(`[gateway] error: ${error.message}`);
  process.exitCode = 1;
});
