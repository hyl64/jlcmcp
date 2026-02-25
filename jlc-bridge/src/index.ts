import * as extensionConfig from '../extension.json';

const APP_NAME = String((extensionConfig as any).displayName || 'JLC Bridge');
const APP_VERSION = String((extensionConfig as any).version || '0.0.0');
const BRIDGE_DIR = 'C:\\Users\\0\\.openclaw\\workspace\\jlc-bridge';
const COMMAND_FILE = `${BRIDGE_DIR}\\command.json`;
const RESULT_FILE = `${BRIDGE_DIR}\\result.json`;
const LOG_FILE = `${BRIDGE_DIR}\\bridge.log`;
const POLL_INTERVAL_MS = 500;
const ENABLED_STORAGE_KEY = 'jlcBridgeEnabled';
const TIMER_ID = 'jlc_bridge_poll_loop';

let bridgeEnabled = false;
let nativeIntervalHandle: ReturnType<typeof setInterval> | null = null;
let usingNativeTimer = false;
let usingSysTimer = false;
let lastCommandTime = 0;
let pollInProgress = false;

// ─── WebSocket state ───
const WS_URL = 'ws://127.0.0.1:18800/ws/bridge';
const WS_RECONNECT_MS = 3000;
let wsConnection: WebSocket | null = null;
let wsConnected = false;
let wsReconnectHandle: ReturnType<typeof setTimeout> | null = null;

type BridgeCommand = {
  id: string;
  action: string;
  params: Record<string, any>;
  timestamp: number;
};

type BridgeResult = {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
  durationMs?: number;
};

function anyEda(): any {
  return eda as any;
}

function hasLegacyFileApi(): boolean {
  const fileApi = anyEda()?.sys_File;
  return Boolean(fileApi?.readFile && fileApi?.writeFile);
}

function hasFileSystemApi(): boolean {
  const fsApi = anyEda()?.sys_FileSystem;
  return Boolean(fsApi?.readFileFromFileSystem && fsApi?.saveFileToFileSystem);
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.readFile) {
      const content = fileApi.readFile(filePath);
      if (typeof content === 'string') return content;
      return undefined;
    }
  } catch {
    // continue with fallback
  }

  try {
    const fsApi = anyEda()?.sys_FileSystem;
    if (!fsApi?.readFileFromFileSystem) return undefined;

    const file: File | undefined = await fsApi.readFileFromFileSystem(filePath);
    if (!file) return undefined;
    if (typeof file.text !== 'function') return undefined;
    return await file.text();
  } catch {
    return undefined;
  }
}

async function writeTextFile(filePath: string, content: string): Promise<boolean> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.writeFile) {
      fileApi.writeFile(filePath, content);
      return true;
    }
  } catch {
    // continue with fallback
  }

  try {
    const fsApi = anyEda()?.sys_FileSystem;
    if (!fsApi?.saveFileToFileSystem) return false;

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const ok = await fsApi.saveFileToFileSystem(filePath, blob, undefined, true);
    return Boolean(ok);
  } catch {
    return false;
  }
}

async function ensureBridgeDir(): Promise<void> {
  try {
    const fileApi = anyEda()?.sys_File;
    if (fileApi?.mkdir) {
      fileApi.mkdir(BRIDGE_DIR);
    }
  } catch {
    // ignore
  }
}

function showInfo(content: string, title = APP_NAME): void {
  try {
    anyEda()?.sys_Dialog?.showInformationMessage?.(content, title);
    return;
  } catch {
    // fall through
  }

  try {
    (globalThis as any).alert?.(`${title}\n${content}`);
    return;
  } catch {
    // fall through
  }

  console.log(`[${APP_NAME}] ${title}: ${content}`);
}

function showError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  showInfo(`${title}\n${message}`, APP_NAME);
  console.error(`[${APP_NAME}]`, title, error);
}

function appendLog(message: string): void {
  void (async () => {
    await ensureBridgeDir();
    const line = `${new Date().toISOString()} ${message}\n`;
    const prev = (await readTextFile(LOG_FILE)) || '';
    await writeTextFile(LOG_FILE, prev + line);
  })();
}

function log(message: string): void {
  console.log(`[${APP_NAME}] ${message}`);
  appendLog(message);
}

function readEnabledPref(): boolean {
  try {
    const raw = anyEda()?.sys_Storage?.getExtensionUserConfig?.(ENABLED_STORAGE_KEY);
    return raw === true || raw === 'true' || raw === 1;
  } catch {
    return false;
  }
}

async function saveEnabledPref(enabled: boolean): Promise<void> {
  try {
    await anyEda()?.sys_Storage?.setExtensionUserConfig?.(ENABLED_STORAGE_KEY, enabled);
  } catch {
    // ignore
  }
}

function getTimerMode(): string {
  if (usingSysTimer) return 'sys_Timer';
  if (usingNativeTimer) return 'setInterval';
  return 'none';
}

function getFileApiMode(): string {
  const modes: string[] = [];
  if (hasLegacyFileApi()) modes.push('sys_File');
  if (hasFileSystemApi()) modes.push('sys_FileSystem');
  return modes.length ? modes.join(' + ') : 'none';
}

function readFirstStringValue(target: any, getterNames: string[]): string {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const raw = getter.call(target);
      if (typeof raw === 'string') {
        const text = raw.trim();
        if (text) return text;
      } else if (raw !== undefined && raw !== null) {
        const text = String(raw).trim();
        if (text) return text;
      }
    } catch {
      // ignore getter errors
    }
  }
  return '';
}

function readFirstNumberValue(target: any, getterNames: string[]): number | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      const value = Number(getter.call(target));
      if (Number.isFinite(value)) return value;
    } catch {
      // ignore getter errors
    }
  }
  return undefined;
}

function readFirstBooleanValue(target: any, getterNames: string[]): boolean | undefined {
  for (const getterName of getterNames) {
    try {
      const getter = target?.[getterName];
      if (typeof getter !== 'function') continue;
      return Boolean(getter.call(target));
    } catch {
      // ignore getter errors
    }
  }
  return undefined;
}

function normalizeNetArray(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string') {
      const net = item.trim();
      if (net) dedup.add(net);
      continue;
    }

    if (item && typeof item === 'object') {
      const netRaw = (item as any).net;
      if (typeof netRaw === 'string') {
        const net = netRaw.trim();
        if (net) dedup.add(net);
      }
    }
  }
  return Array.from(dedup);
}

type Box = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function toFinite(value: any, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeAngle(angle: number): number {
  let value = toFinite(angle, 0);
  while (value <= -180) value += 360;
  while (value > 180) value -= 360;
  return value;
}

function createBoxFromCenter(x: number, y: number, width: number, height: number): Box {
  const halfW = Math.max(0, toFinite(width, 0) / 2);
  const halfH = Math.max(0, toFinite(height, 0) / 2);
  return {
    minX: x - halfW,
    minY: y - halfH,
    maxX: x + halfW,
    maxY: y + halfH,
  };
}

function isVerticalAngle(angle: number): boolean {
  const a = Math.abs(normalizeAngle(angle));
  return Math.abs(a - 90) <= 20;
}

function estimateStringBox(x: number, y: number, text: string, fontSize: number, rotation: number): Box {
  const content = String(text || '');
  const size = Math.max(1, toFinite(fontSize, 10));
  const estimatedWidth = Math.max(size * Math.max(content.length, 1) * 0.6, size * 0.8);
  const estimatedHeight = Math.max(size, 1);
  const width = isVerticalAngle(rotation) ? estimatedHeight : estimatedWidth;
  const height = isVerticalAngle(rotation) ? estimatedWidth : estimatedHeight;
  return createBoxFromCenter(x, y, width, height);
}

function boxIntersects(a: Box, b: Box, tolerance = 0): boolean {
  const t = Math.max(0, toFinite(tolerance, 0));
  if (a.maxX < b.minX - t) return false;
  if (a.minX > b.maxX + t) return false;
  if (a.maxY < b.minY - t) return false;
  if (a.minY > b.maxY + t) return false;
  return true;
}

function boxInside(inner: Box, outer: Box, margin = 0): boolean {
  const m = Math.max(0, toFinite(margin, 0));
  return (
    inner.minX >= outer.minX - m &&
    inner.minY >= outer.minY - m &&
    inner.maxX <= outer.maxX + m &&
    inner.maxY <= outer.maxY + m
  );
}

async function getBBoxOfPrimitive(primitive: any): Promise<Box | undefined> {
  try {
    const bbox = await anyEda()?.pcb_Primitive?.getPrimitivesBBox?.([primitive]);
    if (!bbox) return undefined;
    return {
      minX: toFinite((bbox as any).minX, NaN),
      minY: toFinite((bbox as any).minY, NaN),
      maxX: toFinite((bbox as any).maxX, NaN),
      maxY: toFinite((bbox as any).maxY, NaN),
    };
  } catch {
    return undefined;
  }
}

function firstBox(boxes: Array<Box | undefined>): Box | undefined {
  for (const box of boxes) {
    if (!box) continue;
    const ok =
      Number.isFinite(box.minX) &&
      Number.isFinite(box.minY) &&
      Number.isFinite(box.maxX) &&
      Number.isFinite(box.maxY);
    if (ok) return box;
  }
  return undefined;
}

function makeRectPolygonSource(x1: number, y1: number, x2: number, y2: number): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  return [minX, minY, 'L', maxX, minY, maxX, maxY, minX, maxY];
}

function makeRectPolygonSourceR(x1: number, y1: number, x2: number, y2: number): Array<number | string> {
  const minX = Math.min(toFinite(x1), toFinite(x2));
  const maxX = Math.max(toFinite(x1), toFinite(x2));
  const minY = Math.min(toFinite(y1), toFinite(y2));
  const maxY = Math.max(toFinite(y1), toFinite(y2));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return ['R', minX, minY, width, height, 0, 0];
}

function waitMs(delay: number): Promise<void> {
  const ms = Number.isFinite(delay) && delay > 0 ? Math.floor(delay) : 0;
  if (!ms) return Promise.resolve();

  return new Promise<void>((resolve) => {
    if (typeof setTimeout === 'function') {
      setTimeout(() => resolve(), ms);
      return;
    }

    const timerApi = anyEda()?.sys_Timer;
    if (!timerApi?.setTimeoutTimer) {
      resolve();
      return;
    }

    const timerId = `jlc_bridge_wait_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    timerApi.setTimeoutTimer(timerId, ms, () => {
      try {
        resolve();
      } finally {
        try {
          timerApi.clearTimeoutTimer?.(timerId);
        } catch {
          // ignore
        }
      }
    });
  });
}

function encodeBase64FromArrayBuffer(buffer: ArrayBuffer): string {
  const maybeBuffer = (globalThis as any)?.Buffer;
  if (maybeBuffer?.from) {
    return maybeBuffer.from(buffer).toString('base64');
  }

  if (typeof btoa !== 'function') {
    throw new Error('base64 encoding unavailable');
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const mimeType = blob?.type || 'image/png';
  const buffer = await blob.arrayBuffer();
  const base64 = encodeBase64FromArrayBuffer(buffer);
  return `data:${mimeType};base64,${base64}`;
}

function readTabIdFromDocumentInfo(info: any): string | undefined {
  if (!info) return undefined;

  if (typeof info?.tabId === 'string' && info.tabId.trim()) {
    return info.tabId.trim();
  }

  if (typeof info?.getState_TabId === 'function') {
    try {
      const tabId = info.getState_TabId();
      if (typeof tabId === 'string' && tabId.trim()) {
        return tabId.trim();
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

async function resolveCaptureTabId(): Promise<string | undefined> {
  const api = anyEda();

  try {
    const currentDoc = await api?.dmt_SelectControl?.getCurrentDocumentInfo?.();
    const tabId = readTabIdFromDocumentInfo(currentDoc);
    if (tabId) return tabId;
  } catch {
    // ignore
  }

  try {
    const boardInfo = await api?.dmt_Board?.getCurrentBoardInfo?.();
    const pcbUuid = String(boardInfo?.pcb?.uuid || '').trim();
    if (!pcbUuid) return undefined;

    try {
      const openedTabId = await api?.dmt_EditorControl?.openDocument?.(pcbUuid);
      if (typeof openedTabId === 'string' && openedTabId.trim()) {
        return openedTabId.trim();
      }
    } catch {
      // ignore open error
    }

    return pcbUuid;
  } catch {
    return undefined;
  }
}

async function tryCaptureRenderedAreaImageDataUrl(): Promise<string | undefined> {
  const api = anyEda();
  if (!api?.dmt_EditorControl?.getCurrentRenderedAreaImage) {
    return undefined;
  }

  const tabId = await resolveCaptureTabId();

  if (tabId && api?.dmt_EditorControl?.activateDocument) {
    try {
      await api.dmt_EditorControl.activateDocument(tabId);
    } catch {
      // ignore
    }
  }

  if (api?.dmt_EditorControl?.zoomToAllPrimitives) {
    try {
      await api.dmt_EditorControl.zoomToAllPrimitives(tabId);
    } catch {
      // ignore
    }
  }

  await waitMs(120);

  try {
    const blob: Blob | undefined = await api.dmt_EditorControl.getCurrentRenderedAreaImage(tabId);
    if (blob?.arrayBuffer) {
      return await blobToDataUrl(blob);
    }
  } catch {
    // ignore
  }

  try {
    const fallbackBlob: Blob | undefined = await api.dmt_EditorControl.getCurrentRenderedAreaImage();
    if (fallbackBlob?.arrayBuffer) {
      return await blobToDataUrl(fallbackBlob);
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function getBoardBoundingBox(): Promise<Box | undefined> {
  const api = anyEda();
  const layerCandidates = [api?.EPCB_LayerId?.BOARD_OUTLINE, 11].filter((item) => Number.isFinite(Number(item)));

  let merged: Box | undefined;
  for (const layer of layerCandidates) {
    try {
      const lines = await api?.pcb_PrimitiveLine?.getAll?.(undefined, Number(layer));
      const arcs = await api?.pcb_PrimitiveArc?.getAll?.(undefined, Number(layer));
      const polys = await api?.pcb_PrimitivePolyline?.getAll?.(undefined, Number(layer));
      const rows = [...(Array.isArray(lines) ? lines : []), ...(Array.isArray(arcs) ? arcs : []), ...(Array.isArray(polys) ? polys : [])];
      for (const row of rows) {
        const box = await getBBoxOfPrimitive(row);
        if (!box) continue;
        if (!merged) {
          merged = { ...box };
          continue;
        }
        merged.minX = Math.min(merged.minX, box.minX);
        merged.minY = Math.min(merged.minY, box.minY);
        merged.maxX = Math.max(merged.maxX, box.maxX);
        merged.maxY = Math.max(merged.maxY, box.maxY);
      }
      if (merged) return merged;
    } catch {
      // try next candidate
    }
  }

  try {
    const state = await getPCBState();
    if (state?.boardBounds) {
      return {
        minX: toFinite(state.boardBounds.minX, 0),
        minY: toFinite(state.boardBounds.minY, 0),
        maxX: toFinite(state.boardBounds.maxX, 100),
        maxY: toFinite(state.boardBounds.maxY, 100),
      };
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function getSelectedPrimitiveIdSet(): Promise<Set<string>> {
  const result = new Set<string>();
  try {
    const ids = await anyEda()?.pcb_SelectControl?.getAllSelectedPrimitives_PrimitiveId?.();
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string' && id.trim()) {
          result.add(id.trim());
        }
      }
    }
  } catch {
    // ignore
  }
  return result;
}

async function collectSilkscreenRows(): Promise<any[]> {
  const api = anyEda();
  const dedup = new Map<string, any>();
  const stringApi = api?.pcb_PrimitiveString;
  const tryPushRow = (row: any) => {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) return;
    dedup.set(primitiveId, row);
  };

  if (stringApi?.getAll) {
    for (const layer of [3, 4]) {
      try {
        const rows = await stringApi.getAll(layer);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            tryPushRow(row);
          }
        }
      } catch {
        // ignore layer read error
      }
    }

    if (dedup.size === 0) {
      try {
        const rows = await stringApi.getAll();
        if (Array.isArray(rows)) {
          for (const row of rows) {
            tryPushRow(row);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  if (dedup.size > 0) {
    return Array.from(dedup.values());
  }

  try {
    const rows = await api?.pcb_Document?.getPrimitivesInRegion?.(-1_000_000, 1_000_000, 1_000_000, -1_000_000, false);
    if (!Array.isArray(rows)) return [];
    for (const row of rows) {
      const textGetter = row?.getState_Text;
      if (typeof textGetter !== 'function') continue;
      tryPushRow(row);
    }
  } catch {
    // ignore
  }

  return Array.from(dedup.values());
}

async function buildSilkscreenItem(row: any, selectedSet: Set<string>): Promise<any | null> {
  const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
  if (!primitiveId) return null;

  const text = readFirstStringValue(row, ['getState_Text', 'getState_Content']);
  const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX']);
  const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY']);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const rotation = toFinite(readFirstNumberValue(row, ['getState_Rotation']), 0);
  const fontSize = toFinite(readFirstNumberValue(row, ['getState_FontSize']), 10);
  const parentPrimitiveId = readFirstStringValue(row, ['getState_ParentPrimitiveId', 'getState_BelongPrimitiveId']);
  const layer = readFirstNumberValue(row, ['getState_Layer']);
  const locked = Boolean(readFirstBooleanValue(row, ['getState_PrimitiveLock']));

  const measuredBox = await getBBoxOfPrimitive(row);
  const estimatedBox = estimateStringBox(x, y, text, fontSize, rotation);
  const bbox = firstBox([measuredBox, estimatedBox]) || estimatedBox;

  return {
    primitiveId,
    text,
    x,
    y,
    rotation,
    fontSize,
    parentPrimitiveId: parentPrimitiveId || '',
    layer: Number.isFinite(layer) ? Number(layer) : undefined,
    locked,
    selected: selectedSet.has(primitiveId),
    bbox,
    width: bbox.maxX - bbox.minX,
    height: bbox.maxY - bbox.minY,
  };
}

function buildObstacleBoxFromPrimitiveRow(row: any, diameterGetterNames: string[]): Box | undefined {
  const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX']);
  const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY']);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  const diameter = readFirstNumberValue(row, diameterGetterNames);
  const size = Math.max(1, toFinite(diameter, 10));
  return createBoxFromCenter(x, y, size, size);
}

async function collectPadObstacleBoxes(limit = 10000): Promise<Array<{ primitiveId: string; net: string; box: Box }>> {
  const rows = await anyEda()?.pcb_PrimitivePad?.getAll?.();
  const result: Array<{ primitiveId: string; net: string; box: Box }> = [];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;
    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    const measuredBox = await getBBoxOfPrimitive(row);
    const estimatedBox = buildObstacleBoxFromPrimitiveRow(row, ['getState_Diameter', 'getState_PadDiameter']);
    const box = firstBox([measuredBox, estimatedBox]);
    if (!box) continue;
    result.push({ primitiveId, net, box });
    if (result.length >= limit) break;
  }
  return result;
}

async function collectViaObstacleBoxes(limit = 10000): Promise<Array<{ primitiveId: string; net: string; box: Box }>> {
  const rows = await anyEda()?.pcb_PrimitiveVia?.getAll?.();
  const result: Array<{ primitiveId: string; net: string; box: Box }> = [];
  if (!Array.isArray(rows)) return result;

  for (const row of rows) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;
    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    const measuredBox = await getBBoxOfPrimitive(row);
    const estimatedBox = buildObstacleBoxFromPrimitiveRow(row, ['getState_Diameter']);
    const box = firstBox([measuredBox, estimatedBox]);
    if (!box) continue;
    result.push({ primitiveId, net, box });
    if (result.length >= limit) break;
  }
  return result;
}

async function detectSilkscreenConflicts(
  silkscreens: any[],
): Promise<{
  perSilk: Map<string, any[]>;
  stats: { totalConflicts: number; byType: Record<string, number> };
  boardBox?: Box;
}> {
  const padObstacles = await collectPadObstacleBoxes();
  const viaObstacles = await collectViaObstacleBoxes();
  const boardBox = await getBoardBoundingBox();
  const perSilk = new Map<string, any[]>();
  const byType: Record<string, number> = {};
  let totalConflicts = 0;

  const pushConflict = (silkId: string, conflict: any) => {
    if (!perSilk.has(silkId)) perSilk.set(silkId, []);
    perSilk.get(silkId)!.push(conflict);
    const key = String(conflict.type || 'unknown');
    byType[key] = (byType[key] || 0) + 1;
    totalConflicts += 1;
  };

  for (const silk of silkscreens) {
    const silkBox: Box | undefined = silk?.bbox;
    const silkId = String(silk?.primitiveId || '');
    if (!silkBox || !silkId) continue;

    if (boardBox && !boxInside(silkBox, boardBox, 0)) {
      pushConflict(silkId, {
        type: 'out_of_board',
        targetId: 'BOARD',
        description: 'silkscreen out of board',
      });
    }

    for (const pad of padObstacles) {
      if (boxIntersects(silkBox, pad.box, 0.5)) {
        pushConflict(silkId, {
          type: 'overlap_pad',
          targetId: pad.primitiveId,
          net: pad.net || '',
          description: 'silkscreen overlaps pad',
        });
      }
    }

    for (const via of viaObstacles) {
      if (boxIntersects(silkBox, via.box, 0.5)) {
        pushConflict(silkId, {
          type: 'overlap_via',
          targetId: via.primitiveId,
          net: via.net || '',
          description: 'silkscreen overlaps via',
        });
      }
    }
  }

  for (let i = 0; i < silkscreens.length; i += 1) {
    const a = silkscreens[i];
    const boxA: Box | undefined = a?.bbox;
    const idA = String(a?.primitiveId || '');
    if (!boxA || !idA) continue;

    for (let j = i + 1; j < silkscreens.length; j += 1) {
      const b = silkscreens[j];
      const boxB: Box | undefined = b?.bbox;
      const idB = String(b?.primitiveId || '');
      if (!boxB || !idB) continue;
      if (!boxIntersects(boxA, boxB, 0.5)) continue;

      pushConflict(idA, {
        type: 'overlap_silkscreen',
        targetId: idB,
        description: 'silkscreen overlaps silkscreen',
      });
      pushConflict(idB, {
        type: 'overlap_silkscreen',
        targetId: idA,
        description: 'silkscreen overlaps silkscreen',
      });
    }
  }

  return {
    perSilk,
    stats: {
      totalConflicts,
      byType,
    },
    boardBox: boardBox || undefined,
  };
}

async function getSilkscreens(params?: { includeConflicts?: boolean; onlyConflicted?: boolean; limit?: number }): Promise<any> {
  const rows = await collectSilkscreenRows();
  const selectedSet = await getSelectedPrimitiveIdSet();
  const limitRaw = toFinite(params?.limit, 20000);
  const limit = Math.max(1, Math.floor(limitRaw));

  const silkscreens: any[] = [];
  for (const row of rows) {
    const item = await buildSilkscreenItem(row, selectedSet);
    if (!item) continue;
    silkscreens.push(item);
    if (silkscreens.length >= limit) break;
  }

  const includeConflicts = Boolean(params?.includeConflicts || params?.onlyConflicted);
  if (!includeConflicts) {
    return {
      totalSilkscreens: silkscreens.length,
      returnedSilkscreens: silkscreens.length,
      silkscreens,
    };
  }

  const conflictResult = await detectSilkscreenConflicts(silkscreens);
  const onlyConflicted = Boolean(params?.onlyConflicted);
  const output = [];
  for (const item of silkscreens) {
    const conflicts = conflictResult.perSilk.get(item.primitiveId) || [];
    const next = {
      ...item,
      hasConflict: conflicts.length > 0,
      conflicts,
      conflictCount: conflicts.length,
    };
    if (!onlyConflicted || next.hasConflict) {
      output.push(next);
    }
  }

  return {
    totalSilkscreens: silkscreens.length,
    returnedSilkscreens: output.length,
    conflictSummary: conflictResult.stats,
    boardBox: conflictResult.boardBox || null,
    silkscreens: output,
  };
}

async function moveSilkscreen(params: { primitiveId: string; x: number; y: number; rotation?: number }): Promise<any> {
  const api = anyEda();
  if (!params?.primitiveId) throw new Error('primitiveId is required');
  if (!Number.isFinite(Number(params?.x)) || !Number.isFinite(Number(params?.y))) {
    throw new Error('x/y must be numbers');
  }
  if (!api?.pcb_PrimitiveString?.modify) {
    throw new Error('current EDA does not support silkscreen modify');
  }

  const property: any = {
    x: Number(params.x),
    y: Number(params.y),
  };
  if (params.rotation !== undefined) {
    property.rotation = Number(params.rotation);
  }

  await api.pcb_PrimitiveString.modify(String(params.primitiveId), property);
  return {
    primitiveId: String(params.primitiveId),
    x: Number(params.x),
    y: Number(params.y),
    rotation: params.rotation !== undefined ? Number(params.rotation) : undefined,
  };
}

function makeTranslatedSilkBox(item: any, x: number, y: number, rotation: number): Box {
  const w = Math.max(1, toFinite(item?.width, 10));
  const h = Math.max(1, toFinite(item?.height, 10));
  const vertical = isVerticalAngle(rotation);
  return createBoxFromCenter(x, y, vertical ? h : w, vertical ? w : h);
}

async function autoSilkscreen(params?: {
  maxMoves?: number;
  step?: number;
  maxRadius?: number;
  tryAngles?: number[];
  onlyConflicted?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveString?.modify) {
    throw new Error('current EDA does not support silkscreen modify');
  }

  const maxMoves = Math.max(1, Math.floor(toFinite(params?.maxMoves, 80)));
  const step = Math.max(2, toFinite(params?.step, 12));
  const maxRadius = Math.max(step, toFinite(params?.maxRadius, 96));
  const angleCandidatesBase = Array.isArray(params?.tryAngles) && params?.tryAngles.length > 0
    ? params!.tryAngles.map((a) => toFinite(a, 0))
    : [0, 90, 180, -90];

  const silkResult = await getSilkscreens({ includeConflicts: true, onlyConflicted: Boolean(params?.onlyConflicted) });
  const items: any[] = Array.isArray(silkResult?.silkscreens) ? silkResult.silkscreens : [];
  if (items.length === 0) {
    return {
      total: 0,
      moved: 0,
      improved: 0,
      skipped: 0,
      details: [],
    };
  }

  const padObstacles = await collectPadObstacleBoxes();
  const viaObstacles = await collectViaObstacleBoxes();
  const boardBox = (await getBoardBoundingBox()) || undefined;

  const fixedBoxes = new Map<string, Box>();
  for (const item of items) {
    if (item?.primitiveId && item?.bbox) {
      fixedBoxes.set(String(item.primitiveId), item.bbox as Box);
    }
  }

  const evaluateScore = (selfId: string, candidateBox: Box): number => {
    let score = 0;
    for (const pad of padObstacles) {
      if (boxIntersects(candidateBox, pad.box, 0.5)) score += 20;
    }
    for (const via of viaObstacles) {
      if (boxIntersects(candidateBox, via.box, 0.5)) score += 18;
    }
    for (const [otherId, otherBox] of fixedBoxes.entries()) {
      if (otherId === selfId) continue;
      if (boxIntersects(candidateBox, otherBox, 0.5)) score += 12;
    }
    if (boardBox && !boxInside(candidateBox, boardBox, 0)) {
      score += 50;
    }
    return score;
  };

  const sortItems = [...items].sort((a, b) => Number(b?.conflictCount || 0) - Number(a?.conflictCount || 0));
  const details: any[] = [];
  let moved = 0;
  let improved = 0;
  let skipped = 0;

  for (const item of sortItems) {
    if (moved >= maxMoves) break;
    const primitiveId = String(item?.primitiveId || '');
    if (!primitiveId || item?.locked) {
      skipped += 1;
      continue;
    }

    const originalX = toFinite(item.x, 0);
    const originalY = toFinite(item.y, 0);
    const originalRot = toFinite(item.rotation, 0);
    const originalBox = makeTranslatedSilkBox(item, originalX, originalY, originalRot);
    const originalScore = evaluateScore(primitiveId, originalBox);

    let best = {
      x: originalX,
      y: originalY,
      rotation: originalRot,
      score: originalScore,
      distance: 0,
    };

    const directionCandidates = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [0, 0],
    ];

    const tryAngles = Array.from(new Set([originalRot, ...angleCandidatesBase]));
    for (let radius = 0; radius <= maxRadius; radius += step) {
      for (const [dx, dy] of directionCandidates) {
        const x = round3(originalX + dx * radius);
        const y = round3(originalY + dy * radius);
        for (const rotation of tryAngles) {
          const box = makeTranslatedSilkBox(item, x, y, rotation);
          const score = evaluateScore(primitiveId, box);
          const distance = Math.hypot(x - originalX, y - originalY);
          if (score < best.score || (score === best.score && distance < best.distance)) {
            best = { x, y, rotation, score, distance };
          }
          if (best.score === 0 && best.distance <= step) {
            break;
          }
        }
      }
    }

    if (best.score < originalScore) {
      await api.pcb_PrimitiveString.modify(primitiveId, {
        x: best.x,
        y: best.y,
        rotation: best.rotation,
      });
      moved += 1;
      improved += 1;
      const finalBox = makeTranslatedSilkBox(item, best.x, best.y, best.rotation);
      fixedBoxes.set(primitiveId, finalBox);
      details.push({
        primitiveId,
        from: { x: originalX, y: originalY, rotation: originalRot, score: originalScore },
        to: { x: best.x, y: best.y, rotation: best.rotation, score: best.score },
      });
    } else {
      skipped += 1;
      details.push({
        primitiveId,
        from: { x: originalX, y: originalY, rotation: originalRot, score: originalScore },
        skipped: true,
      });
    }
  }

  return {
    total: sortItems.length,
    moved,
    improved,
    skipped,
    details,
  };
}

async function getPCBState(): Promise<any> {
  const api = anyEda();

  const components: any[] = [];
  if (api?.pcb_PrimitiveComponent?.getAll) {
    const rows = await api.pcb_PrimitiveComponent.getAll();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const primitiveId = row?.getState_PrimitiveId?.() || '';
        const designator = row?.getState_Designator?.() || '';
        if (!primitiveId || !designator) continue;

        components.push({
          primitiveId,
          designator,
          name: row?.getState_Name?.() || '',
          x: Number(row?.getState_X?.() ?? 0),
          y: Number(row?.getState_Y?.() ?? 0),
          rotation: Number(row?.getState_Rotation?.() ?? 0),
          width: Number(row?.getState_Width?.() ?? 0),
          height: Number(row?.getState_Height?.() ?? 0),
          layer: String(row?.getState_Layer?.() ?? ''),
          locked: Boolean(row?.getState_PrimitiveLock?.()),
          padNets: normalizeNetArray(row?.getState_Pads?.()),
        });
      }
    }
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const c of components) {
    minX = Math.min(minX, c.x - c.width / 2);
    minY = Math.min(minY, c.y - c.height / 2);
    maxX = Math.max(maxX, c.x + c.width / 2);
    maxY = Math.max(maxY, c.y + c.height / 2);
  }

  const nets: any[] = [];
  if (api?.pcb_Net?.getAllNetsName) {
    const names = await api.pcb_Net.getAllNetsName();
    if (Array.isArray(names)) {
      for (const name of names) {
        if (typeof name === 'string' && name.trim()) {
          const netName = name.trim();
          let length: number | undefined;
          try {
            length = await api.pcb_Net.getNetLength(netName);
          } catch {
            // ignore
          }
          nets.push({ name: netName, length });
        }
      }
    }
  }

  return {
    components,
    nets,
    boardBounds: {
      minX: minX === Number.POSITIVE_INFINITY ? 0 : minX,
      minY: minY === Number.POSITIVE_INFINITY ? 0 : minY,
      maxX: maxX === Number.NEGATIVE_INFINITY ? 100 : maxX,
      maxY: maxY === Number.NEGATIVE_INFINITY ? 100 : maxY,
    },
    layerCount: 2,
  };
}

async function getPads(params?: { nets?: string[] | string; limit?: number; includeBBox?: boolean }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePad?.getAll) {
    throw new Error('current EDA does not support pad query');
  }

  const rows = await api.pcb_PrimitivePad.getAll();
  const limitRaw = Number(params?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10000;
  const includeBBox = Boolean(params?.includeBBox);

  const netsInput = Array.isArray(params?.nets)
    ? params?.nets
    : typeof params?.nets === 'string'
    ? params.nets.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const netFilter = new Set<string>(netsInput.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean));

  const pads: any[] = [];
  for (const row of rows || []) {
    const primitiveId = readFirstStringValue(row, ['getState_PrimitiveId']);
    if (!primitiveId) continue;

    const net = readFirstStringValue(row, ['getState_Net', 'getState_NetName']);
    if (netFilter.size > 0) {
      if (!net || !netFilter.has(net.toUpperCase())) {
        continue;
      }
    }

    const x = readFirstNumberValue(row, ['getState_X', 'getState_CenterX', 'getState_PosX']);
    const y = readFirstNumberValue(row, ['getState_Y', 'getState_CenterY', 'getState_PosY']);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    const layerRaw = readFirstNumberValue(row, ['getState_Layer']);
    const layer = Number.isFinite(layerRaw) ? Number(layerRaw) : undefined;

    const pad: any = {
      primitiveId,
      net: net || '',
      x,
      y,
      layer: layer !== undefined ? layer : String(readFirstStringValue(row, ['getState_Layer']) || ''),
      parentPrimitiveId: readFirstStringValue(row, [
        'getState_ParentPrimitiveId',
        'getState_BelongPrimitiveId',
        'getState_ComponentPrimitiveId',
      ]),
      designator: readFirstStringValue(row, ['getState_Designator']),
      locked: Boolean(readFirstBooleanValue(row, ['getState_PrimitiveLock'])),
      holeDiameter: readFirstNumberValue(row, ['getState_HoleDiameter', 'getState_DrillDiameter']),
      diameter: readFirstNumberValue(row, ['getState_Diameter', 'getState_PadDiameter']),
      shape: readFirstStringValue(row, ['getState_Shape', 'getState_PadShape']),
    };

    if (includeBBox) {
      try {
        const bbox = await api.pcb_Primitive.getPrimitivesBBox([row as any]);
        if (bbox) {
          pad.bbox = {
            minX: bbox.minX,
            minY: bbox.minY,
            maxX: bbox.maxX,
            maxY: bbox.maxY,
          };
        }
      } catch {
        // ignore bbox errors
      }
    }

    pads.push(pad);
    if (pads.length >= limit) break;
  }

  const netStats = new Map<string, number>();
  for (const item of pads) {
    const key = String(item.net || '').trim();
    if (!key) continue;
    netStats.set(key, (netStats.get(key) || 0) + 1);
  }

  const nets = Array.from(netStats.entries())
    .map(([name, padCount]) => ({ name, padCount }))
    .sort((a, b) => b.padCount - a.padCount);

  return {
    totalPads: Array.isArray(rows) ? rows.length : 0,
    returnedPads: pads.length,
    nets,
    pads,
  };
}

async function moveComponent(params: { designator: string; x: number; y: number; rotation?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.getAll || !api?.pcb_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support component modify');
  }

  const rows = await api.pcb_PrimitiveComponent.getAll();
  let targetId: string | null = null;
  let targetRow: any = null;

  for (const row of rows) {
    const designator = row?.getState_Designator?.() || '';
    if (designator === params.designator) {
      targetId = row?.getState_PrimitiveId?.() || null;
      targetRow = row;
      break;
    }
  }

  if (!targetId) throw new Error(`component not found: ${params.designator}`);
  if (targetRow?.getState_PrimitiveLock?.()) {
    throw new Error(`component locked: ${params.designator}`);
  }

  await api.pcb_PrimitiveComponent.modify(targetId, {
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  });

  return {
    moved: params.designator,
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  };
}

function parsePrimitiveIds(params: any): string | string[] {
  if (Array.isArray(params?.primitiveIds)) {
    const ids = params.primitiveIds.map((item: any) => String(item || '').trim()).filter(Boolean);
    if (ids.length === 0) {
      throw new Error('primitiveIds must not be empty');
    }
    return ids;
  }
  if (params?.primitiveId !== undefined) {
    const id = String(params.primitiveId || '').trim();
    if (!id) throw new Error('primitiveId must not be empty');
    return id;
  }
  if (params?.id !== undefined) {
    const id = String(params.id || '').trim();
    if (!id) throw new Error('id must not be empty');
    return id;
  }
  throw new Error('primitiveId or primitiveIds is required');
}

function getRectParams(params: any): { x1: number; y1: number; x2: number; y2: number } {
  const x1 = toFinite(params?.x1, NaN);
  const y1 = toFinite(params?.y1, NaN);
  const x2 = toFinite(params?.x2, NaN);
  const y2 = toFinite(params?.y2, NaN);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    throw new Error('x1/y1/x2/y2 are required');
  }
  return { x1, y1, x2, y2 };
}

function getPrimitiveId(primitive: any): string {
  try {
    const id = primitive?.getState_PrimitiveId?.();
    if (typeof id === 'string' && id.trim()) return id.trim();
  } catch {
    // ignore
  }
  return '';
}

function makeRectPolygon(params: { x1: number; y1: number; x2: number; y2: number }): any {
  const api = anyEda();
  const sourceLine = makeRectPolygonSource(params.x1, params.y1, params.x2, params.y2);
  const sourceRect = makeRectPolygonSourceR(params.x1, params.y1, params.x2, params.y2);
  const polygonByLine = api?.pcb_MathPolygon?.createPolygon?.(sourceLine as any);
  if (polygonByLine) return polygonByLine;
  const polygonByRect = api?.pcb_MathPolygon?.createPolygon?.(sourceRect as any);
  if (polygonByRect) return polygonByRect;
  throw new Error('failed to create rectangle polygon');
}

function buildRectPolygonCandidates(params: { x1: number; y1: number; x2: number; y2: number }): any[] {
  const api = anyEda();
  const sourceLine = makeRectPolygonSource(params.x1, params.y1, params.x2, params.y2);
  const sourceRect = makeRectPolygonSourceR(params.x1, params.y1, params.x2, params.y2);
  const list: any[] = [];

  const add = (item: any) => {
    if (!item) return;
    list.push(item);
  };

  add(api?.pcb_MathPolygon?.createPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createPolygon?.(sourceRect as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceLine as any));
  add(api?.pcb_MathPolygon?.createComplexPolygon?.(sourceRect as any));
  add(sourceLine as any);
  add(sourceRect as any);
  return list;
}

async function createVia(params: {
  net: string;
  x: number;
  y: number;
  holeDiameter?: number;
  diameter?: number;
  viaType?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveVia?.create) {
    throw new Error('current EDA does not support via create');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');

  const x = toFinite(params?.x, NaN);
  const y = toFinite(params?.y, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x/y are required');

  const holeDiameter = Math.max(1, toFinite(params?.holeDiameter, 10));
  const diameter = Math.max(holeDiameter + 1, toFinite(params?.diameter, 22));
  const viaType = Number.isFinite(Number(params?.viaType)) ? Number(params.viaType) : undefined;
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const via = await api.pcb_PrimitiveVia.create(net, x, y, holeDiameter, diameter, viaType, undefined, undefined, primitiveLock);
  return {
    primitiveId: getPrimitiveId(via),
    net,
    x,
    y,
    holeDiameter,
    diameter,
    viaType: viaType ?? null,
  };
}

async function deleteVia(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveVia?.delete) {
    throw new Error('current EDA does not support via delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveVia.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createKeepoutRect(params: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer?: number;
  ruleTypes?: number[];
  regionName?: string;
  lineWidth?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveRegion?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('current EDA does not support region create');
  }

  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 12;
  const ruleTypes = Array.isArray(params?.ruleTypes) && params.ruleTypes.length > 0
    ? params.ruleTypes.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [2, 3, 5, 6, 7];
  const regionName = String(params?.regionName || `KEEP_OUT_${Date.now()}`);
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 4));
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const layerCandidates = Array.from(new Set([requestedLayer, 12, 1, 2].filter((item) => Number.isFinite(item))));
  const polygonCandidates = buildRectPolygonCandidates(rect);
  const ruleTypeCandidates: Array<any> = [];
  if (ruleTypes.length > 0) ruleTypeCandidates.push(ruleTypes);
  ruleTypeCandidates.push([5], [2, 3, 5, 6, 7], undefined);
  const nameCandidates = [regionName, undefined];
  const lineWidthCandidates = [lineWidth, undefined];

  let region: any = undefined;
  let usedLayer = requestedLayer;
  let usedRuleTypes: any = ruleTypes;
  let usedName: any = regionName;
  let usedLineWidth: any = lineWidth;
  let lastError: any = null;

  outer: for (const layer of layerCandidates) {
    for (const polygon of polygonCandidates) {
      for (const rt of ruleTypeCandidates) {
        for (const rn of nameCandidates) {
          for (const lw of lineWidthCandidates) {
            try {
              region = await api.pcb_PrimitiveRegion.create(layer, polygon, rt, rn, lw, primitiveLock);
              if (region) {
                usedLayer = layer;
                usedRuleTypes = rt;
                usedName = rn;
                usedLineWidth = lw;
                break outer;
              }
            } catch (error) {
              lastError = error;
            }
          }
        }
      }
    }
  }

  if (!region) {
    if (lastError) throw lastError;
    throw new Error('failed to create keepout region');
  }

  return {
    primitiveId: getPrimitiveId(region),
    layer: usedLayer,
    ruleTypes: Array.isArray(usedRuleTypes) ? usedRuleTypes : [],
    regionName: usedName || '',
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

async function deleteRegion(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveRegion?.delete) {
    throw new Error('current EDA does not support region delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveRegion.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createPourRect(params: {
  net: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  layer?: number;
  fillMethod?: string;
  preserveSilos?: boolean;
  pourName?: string;
  pourPriority?: number;
  lineWidth?: number;
  primitiveLock?: boolean;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.create || !api?.pcb_MathPolygon?.createPolygon) {
    throw new Error('current EDA does not support pour create');
  }

  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');
  const rect = getRectParams(params);
  const requestedLayer = Number.isFinite(Number(params?.layer)) ? Number(params.layer) : 1;
  const fillMethod = String(params?.fillMethod || 'solid').trim().toLowerCase();
  const preserveSilos = params?.preserveSilos !== undefined ? Boolean(params.preserveSilos) : false;
  const pourName = String(params?.pourName || `POUR_${net}_${Date.now()}`);
  const pourPriority = Math.max(1, Math.floor(toFinite(params?.pourPriority, 1)));
  const lineWidth = Math.max(0, toFinite(params?.lineWidth, 8));
  const primitiveLock = params?.primitiveLock !== undefined ? Boolean(params.primitiveLock) : false;

  const layerCandidates = Array.from(new Set([requestedLayer, 1, 2].filter((item) => Number.isFinite(item))));
  const polygonCandidates = buildRectPolygonCandidates(rect);
  const fillMethodCandidates = Array.from(new Set([fillMethod, 'solid', undefined] as Array<any>));
  const preserveCandidates = Array.from(new Set([preserveSilos, false, true]));
  const nameCandidates = [pourName, undefined];
  const priorityCandidates = [pourPriority, undefined];
  const lineWidthCandidates = [lineWidth, undefined];

  let pour: any = undefined;
  let usedLayer = requestedLayer;
  let usedFillMethod: any = fillMethod;
  let usedPreserveSilos: any = preserveSilos;
  let usedName: any = pourName;
  let usedPriority: any = pourPriority;
  let usedLineWidth: any = lineWidth;
  let lastError: any = null;

  outer: for (const layer of layerCandidates) {
    for (const polygon of polygonCandidates) {
      for (const fm of fillMethodCandidates) {
        for (const ps of preserveCandidates) {
          for (const pn of nameCandidates) {
            for (const pp of priorityCandidates) {
              for (const lw of lineWidthCandidates) {
                try {
                  pour = await api.pcb_PrimitivePour.create(
                    net,
                    layer,
                    polygon,
                    fm,
                    ps,
                    pn,
                    pp,
                    lw,
                    primitiveLock,
                  );
                  if (pour) {
                    usedLayer = layer;
                    usedFillMethod = fm;
                    usedPreserveSilos = ps;
                    usedName = pn;
                    usedPriority = pp;
                    usedLineWidth = lw;
                    break outer;
                  }
                } catch (error) {
                  lastError = error;
                }
              }
            }
          }
        }
      }
    }
  }

  if (!pour) {
    if (lastError) throw lastError;
    throw new Error('failed to create pour');
  }

  return {
    primitiveId: getPrimitiveId(pour),
    net,
    layer: usedLayer,
    fillMethod: usedFillMethod || '',
    preserveSilos: Boolean(usedPreserveSilos),
    pourName: usedName || '',
    pourPriority: Number.isFinite(Number(usedPriority)) ? Number(usedPriority) : null,
    lineWidth: Number.isFinite(Number(usedLineWidth)) ? Number(usedLineWidth) : null,
    rect,
  };
}

async function deletePour(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitivePour?.delete) {
    throw new Error('current EDA does not support pour delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitivePour.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function createDifferentialPair(params: { name: string; positiveNet: string; negativeNet: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.createDifferentialPair) {
    throw new Error('current EDA does not support differential pair');
  }

  const name = String(params?.name || '').trim();
  const positiveNet = String(params?.positiveNet || '').trim();
  const negativeNet = String(params?.negativeNet || '').trim();
  if (!name || !positiveNet || !negativeNet) {
    throw new Error('name/positiveNet/negativeNet are required');
  }

  const ok = await api.pcb_Drc.createDifferentialPair(name, positiveNet, negativeNet);
  return { created: Boolean(ok), name, positiveNet, negativeNet };
}

async function deleteDifferentialPair(params: { name: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.deleteDifferentialPair) {
    throw new Error('current EDA does not support differential pair');
  }
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('name is required');
  const ok = await api.pcb_Drc.deleteDifferentialPair(name);
  return { deleted: Boolean(ok), name };
}

async function listDifferentialPairs(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.getAllDifferentialPairs) {
    throw new Error('current EDA does not support differential pair');
  }
  const rows = await api.pcb_Drc.getAllDifferentialPairs();
  const pairs = Array.isArray(rows)
    ? rows.map((row: any) => ({
        name: String(row?.name || ''),
        positiveNet: String(row?.positiveNet || ''),
        negativeNet: String(row?.negativeNet || ''),
      }))
    : [];
  return { totalPairs: pairs.length, pairs };
}

async function createEqualLengthGroup(params: {
  name: string;
  nets: string[];
  color?: { r: number; g: number; b: number; alpha: number };
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.createEqualLengthNetGroup) {
    throw new Error('current EDA does not support equal-length group');
  }
  const name = String(params?.name || '').trim();
  const nets = Array.isArray(params?.nets)
    ? params.nets.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!name || nets.length === 0) {
    throw new Error('name and nets are required');
  }
  const color = params?.color || { r: 255, g: 128, b: 0, alpha: 1 };
  const ok = await api.pcb_Drc.createEqualLengthNetGroup(name, nets, color);
  return { created: Boolean(ok), name, nets, color };
}

async function deleteEqualLengthGroup(params: { name: string }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.deleteEqualLengthNetGroup) {
    throw new Error('current EDA does not support equal-length group');
  }
  const name = String(params?.name || '').trim();
  if (!name) throw new Error('name is required');
  const ok = await api.pcb_Drc.deleteEqualLengthNetGroup(name);
  return { deleted: Boolean(ok), name };
}

async function listEqualLengthGroups(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.getAllEqualLengthNetGroups) {
    throw new Error('current EDA does not support equal-length group');
  }
  const rows = await api.pcb_Drc.getAllEqualLengthNetGroups();
  const groups = Array.isArray(rows)
    ? rows.map((row: any) => ({
        name: String(row?.name || ''),
        nets: Array.isArray(row?.nets) ? row.nets : [],
        color: row?.color || null,
      }))
    : [];
  return { totalGroups: groups.length, groups };
}

// ─── Board / Schematic / Cross-document commands ───

async function getBoardInfo(): Promise<any> {
  const api = anyEda();
  if (!api?.dmt_Board?.getCurrentBoardInfo) {
    throw new Error('current EDA does not support dmt_Board.getCurrentBoardInfo');
  }
  const info = await api.dmt_Board.getCurrentBoardInfo();
  return {
    name: String(info?.name || info?.title || ''),
    schematicUuid: String(info?.schematicUuid || info?.schUuid || info?.sch_uuid || ''),
    pcbUuid: String(info?.pcbUuid || info?.pcb_uuid || ''),
  };
}

async function openDocument(params: { uuid: string }): Promise<any> {
  const api = anyEda();
  if (!api?.dmt_EditorControl?.openDocument) {
    throw new Error('current EDA does not support dmt_EditorControl.openDocument');
  }
  const uuid = String(params?.uuid || '').trim();
  if (!uuid) throw new Error('uuid is required');
  await api.dmt_EditorControl.openDocument(uuid);
  // Wait for document to load
  await new Promise(r => setTimeout(r, 500));
  return { opened: uuid };
}

async function getSchematicState(): Promise<any> {
  const api = anyEda();
  if (!api?.sch_PrimitiveComponent?.getAll) {
    throw new Error('current EDA does not support sch_PrimitiveComponent.getAll');
  }

  // Read all components across all schematic pages
  const rows = await api.sch_PrimitiveComponent.getAll(undefined, true);
  const components = (Array.isArray(rows) ? rows : []).map((r: any) => ({
    primitiveId: r?.getState_PrimitiveId?.() || '',
    designator: r?.getState_Designator?.() || '',
    name: r?.getState_Name?.() || r?.getState_DisplayName?.() || '',
    value: r?.getState_Value?.() || '',
    component: {
      libraryUuid: r?.getState_LibraryUuid?.() || r?.getState_ComponentLibraryUuid?.() || '',
      uuid: r?.getState_Uuid?.() || r?.getState_ComponentUuid?.() || '',
    },
  })).filter((c: any) => c.primitiveId);

  // Read pins
  let pins: any[] = [];
  if (api?.sch_PrimitivePin?.getAll) {
    try {
      const pinRows = await api.sch_PrimitivePin.getAll();
      pins = (Array.isArray(pinRows) ? pinRows : []).map((p: any) => ({
        primitiveId: p?.getState_PrimitiveId?.() || '',
        pinNumber: p?.getState_PinNumber?.() || p?.getState_Number?.() || '',
        pinName: p?.getState_PinName?.() || p?.getState_Name?.() || '',
        net: p?.getState_Net?.() || p?.getState_NetName?.() || '',
        x: Number(p?.getState_X?.() ?? 0),
        y: Number(p?.getState_Y?.() ?? 0),
      })).filter((p: any) => p.primitiveId);
    } catch { /* ignore */ }
  }

  // Read wires
  let wires: any[] = [];
  if (api?.sch_PrimitiveWire?.getAll) {
    try {
      const wireRows = await api.sch_PrimitiveWire.getAll();
      wires = (Array.isArray(wireRows) ? wireRows : []).map((w: any) => ({
        primitiveId: w?.getState_PrimitiveId?.() || '',
        net: w?.getState_Net?.() || w?.getState_NetName?.() || '',
      })).filter((w: any) => w.primitiveId);
    } catch { /* ignore */ }
  }

  return { components, pins, wires };
}

async function getNetlist(params: { type?: string }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Netlist?.getNetlist) {
    throw new Error('current EDA does not support sch_Netlist.getNetlist');
  }
  const netlist = await api.sch_Netlist.getNetlist(params?.type);
  return { netlist: typeof netlist === 'string' ? netlist : JSON.stringify(netlist) };
}

async function runSchDrc(params: { strict?: boolean }): Promise<any> {
  const api = anyEda();
  if (!api?.sch_Drc?.check) {
    throw new Error('current EDA does not support sch_Drc.check');
  }
  const strict = params?.strict !== false;
  const result = await api.sch_Drc.check(strict, false);
  return { passed: Boolean(result) };
}

async function createPcbComponent(params: {
  component: { libraryUuid: string; uuid: string };
  layer: number;
  x: number;
  y: number;
  rotation?: number;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.create) {
    throw new Error('current EDA does not support pcb_PrimitiveComponent.create');
  }
  const { component, layer, x, y, rotation } = params;
  if (!component?.libraryUuid || !component?.uuid) {
    throw new Error('component.libraryUuid and component.uuid are required');
  }
  const result = await api.pcb_PrimitiveComponent.create(
    { libraryUuid: component.libraryUuid, uuid: component.uuid },
    layer, x, y, rotation ?? 0, false,
  );
  const primitiveId = result?.getState_PrimitiveId?.() || result?.primitiveId || '';
  const designator = result?.getState_Designator?.() || result?.designator || '';
  return { primitiveId, designator };
}

async function getFeatureSupport(): Promise<any> {
  const api = anyEda();
  return {
    bridgeVersion: APP_VERSION,
    screenshot: {
      renderedAreaImage: Boolean(api?.dmt_EditorControl?.getCurrentRenderedAreaImage),
      exportImage: Boolean(api?.pcb_Document?.exportImage),
      canvasToDataUrl: Boolean(api?.sys_Canvas?.toDataURL),
    },
    silkscreen: {
      query: Boolean(api?.pcb_PrimitiveString?.getAll),
      modify: Boolean(api?.pcb_PrimitiveString?.modify),
      auto: Boolean(api?.pcb_PrimitiveString?.modify),
    },
    via: {
      create: Boolean(api?.pcb_PrimitiveVia?.create),
      delete: Boolean(api?.pcb_PrimitiveVia?.delete),
    },
    keepout: {
      create: Boolean(api?.pcb_PrimitiveRegion?.create && api?.pcb_MathPolygon?.createPolygon),
      delete: Boolean(api?.pcb_PrimitiveRegion?.delete),
    },
    pour: {
      create: Boolean(api?.pcb_PrimitivePour?.create && api?.pcb_MathPolygon?.createPolygon),
      delete: Boolean(api?.pcb_PrimitivePour?.delete),
    },
    routingRules: {
      differentialPair: Boolean(api?.pcb_Drc?.createDifferentialPair),
      equalLengthGroup: Boolean(api?.pcb_Drc?.createEqualLengthNetGroup),
      drcCheck: Boolean(api?.pcb_Drc?.check || api?.pcb_Drc?.runDrc),
      padPairGroup: Boolean(api?.pcb_Drc?.createPadPairGroup),
    },
    schematic: {
      getBoardInfo: Boolean(api?.dmt_Board?.getCurrentBoardInfo),
      openDocument: Boolean(api?.dmt_EditorControl?.openDocument),
      getComponents: Boolean(api?.sch_PrimitiveComponent?.getAll),
      getNetlist: Boolean(api?.sch_Netlist?.getNetlist),
      schDrc: Boolean(api?.sch_Drc?.check),
      createPcbComponent: Boolean(api?.pcb_PrimitiveComponent?.create),
    },
  };
}

// ─── Track / net query & delete ───

async function getTracks(params: { net?: string; layer?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.getAll) {
    throw new Error('current EDA does not support track query');
  }
  const rows = await api.pcb_PrimitiveLine.getAll(params.net, params.layer);
  const tracks = (Array.isArray(rows) ? rows : []).map((r: any) => ({
    primitiveId: r?.getState_PrimitiveId?.() || '',
    net: r?.getState_Net?.() || '',
    layer: r?.getState_Layer?.() ?? '',
    startX: Number(r?.getState_StartX?.() ?? 0),
    startY: Number(r?.getState_StartY?.() ?? 0),
    endX: Number(r?.getState_EndX?.() ?? 0),
    endY: Number(r?.getState_EndY?.() ?? 0),
    width: Number(r?.getState_Width?.() ?? 0),
  })).filter((t: any) => t.primitiveId);
  return { tracks, count: tracks.length };
}

async function deleteTracks(params: { primitiveId?: string; primitiveIds?: string[] }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.delete) {
    throw new Error('current EDA does not support track delete');
  }
  const primitiveIds = parsePrimitiveIds(params);
  const ok = await api.pcb_PrimitiveLine.delete(primitiveIds as any);
  return {
    deleted: Boolean(ok),
    primitiveIds: Array.isArray(primitiveIds) ? primitiveIds : [primitiveIds],
  };
}

async function getNetPrimitives(params: { net: string }): Promise<any> {
  const api = anyEda();
  const net = String(params?.net || '').trim();
  if (!net) throw new Error('net is required');

  const result: { tracks: any[]; vias: any[]; pads: any[] } = { tracks: [], vias: [], pads: [] };

  // Tracks on this net
  if (api?.pcb_PrimitiveLine?.getAll) {
    const rows = await api.pcb_PrimitiveLine.getAll(net);
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = r?.getState_PrimitiveId?.();
      if (!id) continue;
      result.tracks.push({
        primitiveId: id,
        startX: Number(r?.getState_StartX?.() ?? 0),
        startY: Number(r?.getState_StartY?.() ?? 0),
        endX: Number(r?.getState_EndX?.() ?? 0),
        endY: Number(r?.getState_EndY?.() ?? 0),
        layer: r?.getState_Layer?.() ?? '',
        width: Number(r?.getState_Width?.() ?? 0),
      });
    }
  }

  // Vias on this net
  if (api?.pcb_PrimitiveVia?.getAll) {
    try {
      const rows = await api.pcb_PrimitiveVia.getAll();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const viaNet = r?.getState_Net?.() || '';
        if (viaNet !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.vias.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? 0),
        });
      }
    } catch { /* ignore */ }
  }

  // Pads on this net
  if (api?.pcb_PrimitivePad?.getAll) {
    try {
      const rows = await api.pcb_PrimitivePad.getAll();
      for (const r of (Array.isArray(rows) ? rows : [])) {
        const padNet = r?.getState_Net?.() || r?.getState_NetName?.() || '';
        if (padNet !== net) continue;
        const id = r?.getState_PrimitiveId?.();
        if (!id) continue;
        result.pads.push({
          primitiveId: id,
          x: Number(r?.getState_X?.() ?? r?.getState_CenterX?.() ?? 0),
          y: Number(r?.getState_Y?.() ?? r?.getState_CenterY?.() ?? 0),
          designator: r?.getState_Designator?.() || '',
        });
      }
    } catch { /* ignore */ }
  }

  return result;
}

async function relocateComponent(params: {
  designator: string; x: number; y: number; rotation?: number;
}): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveComponent?.getAll || !api?.pcb_PrimitiveComponent?.modify) {
    throw new Error('current EDA does not support component modify');
  }

  // 1. Find the component and read its pad nets
  const rows = await api.pcb_PrimitiveComponent.getAll();
  let targetId: string | null = null;
  let targetRow: any = null;
  for (const row of rows) {
    if ((row?.getState_Designator?.() || '') === params.designator) {
      targetId = row?.getState_PrimitiveId?.() || null;
      targetRow = row;
      break;
    }
  }
  if (!targetId) throw new Error(`component not found: ${params.designator}`);
  if (targetRow?.getState_PrimitiveLock?.()) {
    throw new Error(`component locked: ${params.designator}`);
  }

  const padNets = normalizeNetArray(targetRow?.getState_Pads?.());
  const uniqueNets = [...new Set(padNets.map((p: any) => p.net).filter(Boolean))];

  // 2. Collect pad positions for this component
  const padPositions: { x: number; y: number }[] = [];
  if (api?.pcb_PrimitivePad?.getAll) {
    try {
      const allPads = await api.pcb_PrimitivePad.getAll();
      for (const p of (Array.isArray(allPads) ? allPads : [])) {
        const des = p?.getState_Designator?.() || '';
        const parentId = p?.getState_ParentPrimitiveId?.()
          || p?.getState_BelongPrimitiveId?.()
          || p?.getState_ComponentPrimitiveId?.() || '';
        if (des === params.designator || parentId === targetId) {
          padPositions.push({
            x: Number(p?.getState_X?.() ?? p?.getState_CenterX?.() ?? 0),
            y: Number(p?.getState_Y?.() ?? p?.getState_CenterY?.() ?? 0),
          });
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Find and delete tracks directly connected to this component's pads
  const deletedTracks: string[] = [];
  const COORD_TOLERANCE = 2; // mil tolerance for coordinate matching
  if (api?.pcb_PrimitiveLine?.getAll && api?.pcb_PrimitiveLine?.delete && padPositions.length > 0) {
    for (const net of uniqueNets) {
      try {
        const trackRows = await api.pcb_PrimitiveLine.getAll(net);
        const toDelete: string[] = [];
        for (const t of (Array.isArray(trackRows) ? trackRows : [])) {
          const sx = Number(t?.getState_StartX?.() ?? 0);
          const sy = Number(t?.getState_StartY?.() ?? 0);
          const ex = Number(t?.getState_EndX?.() ?? 0);
          const ey = Number(t?.getState_EndY?.() ?? 0);
          // Check if either endpoint touches a pad of this component
          const touchesPad = padPositions.some(pad =>
            (Math.abs(sx - pad.x) <= COORD_TOLERANCE && Math.abs(sy - pad.y) <= COORD_TOLERANCE) ||
            (Math.abs(ex - pad.x) <= COORD_TOLERANCE && Math.abs(ey - pad.y) <= COORD_TOLERANCE)
          );
          if (touchesPad) {
            const id = t?.getState_PrimitiveId?.();
            if (id) toDelete.push(id);
          }
        }
        if (toDelete.length > 0) {
          await api.pcb_PrimitiveLine.delete(toDelete as any);
          deletedTracks.push(...toDelete);
        }
      } catch { /* ignore per-net errors */ }
    }
  }

  // 4. Move the component
  await api.pcb_PrimitiveComponent.modify(targetId, {
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
  });

  return {
    moved: params.designator,
    x: params.x,
    y: params.y,
    rotation: params.rotation ?? targetRow?.getState_Rotation?.() ?? 0,
    deletedTracks,
    deletedTrackCount: deletedTracks.length,
    netsToReroute: uniqueNets,
  };
}

async function routeTrack(params: { net: string; points: any[]; layer: number; width?: number }): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_PrimitiveLine?.create) {
    throw new Error('current EDA does not support track create');
  }

  const width = params.width ?? 10;
  let created = 0;

  for (let i = 0; i < params.points.length - 1; i += 1) {
    const p1 = params.points[i];
    const p2 = params.points[i + 1];
    try {
      await api.pcb_PrimitiveLine.create(params.net, params.layer, p1.x, p1.y, p2.x, p2.y, width, false);
      created += 1;
    } catch (error) {
      console.error(`[${APP_NAME}] route segment failed`, i, error);
    }
  }

  return { createdSegments: created };
}

async function runDRC(): Promise<any> {
  const api = anyEda();
  if (!api?.pcb_Drc?.check && !api?.pcb_Drc?.runDrc) {
    throw new Error('current EDA does not support DRC');
  }

  let passed: boolean | undefined;
  let issues: any[] = [];

  if (api?.pcb_Drc?.check) {
    try {
      const verbose = await api.pcb_Drc.check(true, false, true);
      if (Array.isArray(verbose)) {
        issues = verbose;
        passed = verbose.length === 0;
      } else if (typeof verbose === 'boolean') {
        passed = verbose;
      }
    } catch {
      // try non-verbose branch
      try {
        const quick = await api.pcb_Drc.check(true, false, false);
        if (typeof quick === 'boolean') {
          passed = quick;
        }
      } catch {
        // ignore
      }
    }
  }

  if (issues.length === 0 && api?.pcb_Drc?.runDrc) {
    try {
      const raw = await api.pcb_Drc.runDrc();
      if (Array.isArray(raw)) {
        issues = raw;
        if (passed === undefined) passed = raw.length === 0;
      }
    } catch {
      // ignore runDrc fallback
    }
  }

  const normalized = issues.map((item: any, index: number) => {
    const rule = String(item?.rule || item?.type || item?.name || '').trim();
    const message = String(item?.message || item?.description || '').trim();
    const refs = Array.isArray(item?.primitiveIds)
      ? item.primitiveIds.map((id: any) => String(id || '')).filter(Boolean)
      : [];
    const text = `${rule} ${message}`.toLowerCase();
    let severity = 'unknown';
    if (/error|错误|违规/.test(text)) severity = 'error';
    else if (/warning|警告/.test(text)) severity = 'warning';
    else if (/info|提示/.test(text)) severity = 'info';

    return {
      index: index + 1,
      severity,
      rule,
      message,
      primitiveIds: refs,
      raw: item,
    };
  });

  if (passed === undefined) {
    passed = normalized.length === 0;
  }

  const summary = {
    errors: normalized.filter((item) => item.severity === 'error').length,
    warnings: normalized.filter((item) => item.severity === 'warning').length,
    infos: normalized.filter((item) => item.severity === 'info').length,
    unknown: normalized.filter((item) => item.severity === 'unknown').length,
  };

  return {
    passed: Boolean(passed),
    totalCount: normalized.length,
    summary,
    issues: normalized,
  };
}

async function takeScreenshot(): Promise<any> {
  const api = anyEda();

  const renderedAreaDataUrl = await tryCaptureRenderedAreaImageDataUrl();
  if (typeof renderedAreaDataUrl === 'string' && renderedAreaDataUrl.startsWith('data:')) {
    return { imageDataUrl: renderedAreaDataUrl };
  }

  if (api?.pcb_Document?.exportImage) {
    try {
      const dataUrl = await api.pcb_Document.exportImage('png');
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        return { imageDataUrl: dataUrl };
      }
    } catch {
      // ignore
    }
  }

  if (api?.sys_Canvas?.toDataURL) {
    try {
      const dataUrl = await api.sys_Canvas.toDataURL('image/png');
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        return { imageDataUrl: dataUrl };
      }
    } catch {
      // ignore
    }
  }

  throw new Error(`screenshot unavailable, save manually to ${BRIDGE_DIR}\\screenshot.png`);
}

async function executeCommand(cmd: BridgeCommand): Promise<BridgeResult> {
  const start = Date.now();
  try {
    let data: any;

    switch (cmd.action) {
      case 'ping':
        data = { message: 'pong', timestamp: Date.now() };
        break;
      case 'get_state':
        data = await getPCBState();
        break;
      case 'get_feature_support':
        data = await getFeatureSupport();
        break;
      case 'screenshot':
        data = await takeScreenshot();
        break;
      case 'get_silkscreens':
        data = await getSilkscreens(cmd.params);
        break;
      case 'move_silkscreen':
        data = await moveSilkscreen(cmd.params);
        break;
      case 'auto_silkscreen':
        data = await autoSilkscreen(cmd.params);
        break;
      case 'move_component':
        data = await moveComponent(cmd.params);
        break;
      case 'route_track':
        data = await routeTrack(cmd.params);
        break;
      case 'create_via':
        data = await createVia(cmd.params);
        break;
      case 'delete_via':
        data = await deleteVia(cmd.params);
        break;
      case 'get_tracks':
        data = await getTracks(cmd.params);
        break;
      case 'delete_tracks':
        data = await deleteTracks(cmd.params);
        break;
      case 'get_net_primitives':
        data = await getNetPrimitives(cmd.params);
        break;
      case 'relocate_component':
        data = await relocateComponent(cmd.params);
        break;
      case 'create_keepout_rect':
        data = await createKeepoutRect(cmd.params);
        break;
      case 'delete_region':
        data = await deleteRegion(cmd.params);
        break;
      case 'create_pour_rect':
        data = await createPourRect(cmd.params);
        break;
      case 'delete_pour':
        data = await deletePour(cmd.params);
        break;
      case 'create_differential_pair':
        data = await createDifferentialPair(cmd.params);
        break;
      case 'delete_differential_pair':
        data = await deleteDifferentialPair(cmd.params);
        break;
      case 'list_differential_pairs':
        data = await listDifferentialPairs();
        break;
      case 'create_equal_length_group':
        data = await createEqualLengthGroup(cmd.params);
        break;
      case 'delete_equal_length_group':
        data = await deleteEqualLengthGroup(cmd.params);
        break;
      case 'list_equal_length_groups':
        data = await listEqualLengthGroups();
        break;
      case 'run_drc':
        data = await runDRC();
        break;
      case 'get_pads':
        data = await getPads(cmd.params);
        break;
      case 'select_component': {
        const api = anyEda();
        if (!api?.pcb_SelectControl?.selectByDesignator) {
          throw new Error('select not supported');
        }
        await api.pcb_SelectControl.selectByDesignator(cmd.params.designator);
        data = { selected: cmd.params.designator };
        break;
      }
      case 'delete_selected': {
        const api = anyEda();
        if (!api?.pcb_SelectControl?.deleteSelected) {
          throw new Error('delete not supported');
        }
        await api.pcb_SelectControl.deleteSelected();
        data = { deleted: true };
        break;
      }
      case 'get_board_info':
        data = await getBoardInfo();
        break;
      case 'open_document':
        data = await openDocument(cmd.params);
        break;
      case 'get_schematic_state':
        data = await getSchematicState();
        break;
      case 'get_netlist':
        data = await getNetlist(cmd.params);
        break;
      case 'run_sch_drc':
        data = await runSchDrc(cmd.params);
        break;
      case 'create_pcb_component':
        data = await createPcbComponent(cmd.params);
        break;
      default:
        throw new Error(`unknown action: ${cmd.action}`);
    }

    return { id: cmd.id, success: true, data, durationMs: Date.now() - start };
  } catch (error) {
    return {
      id: cmd.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
}

async function readCommand(): Promise<BridgeCommand | null> {
  const content = await readTextFile(COMMAND_FILE);
  if (!content || !content.trim()) return null;

  try {
    const cmd = JSON.parse(content) as BridgeCommand;
    if (!cmd || typeof cmd.timestamp !== 'number') return null;
    if (cmd.timestamp <= lastCommandTime) return null;
    return cmd;
  } catch {
    return null;
  }
}

async function clearCommand(): Promise<void> {
  await writeTextFile(COMMAND_FILE, '');
}

async function writeResult(result: BridgeResult): Promise<void> {
  await writeTextFile(RESULT_FILE, JSON.stringify(result, null, 2));
}

async function pollOnce(): Promise<void> {
  if (!bridgeEnabled || pollInProgress) return;

  pollInProgress = true;
  try {
    const cmd = await readCommand();
    if (!cmd) return;

    lastCommandTime = cmd.timestamp;
    await clearCommand();
    const result = await executeCommand(cmd);
    await writeResult(result);
    log(`command done: ${cmd.action} -> ${result.success ? 'ok' : 'fail'}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`poll error: ${message}`);
  } finally {
    pollInProgress = false;
  }
}

function startNativeInterval(): boolean {
  if (nativeIntervalHandle) return true;
  if (typeof setInterval !== 'function') return false;

  nativeIntervalHandle = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);

  usingNativeTimer = true;
  usingSysTimer = false;
  return true;
}

function startSysInterval(): boolean {
  const timerApi = anyEda()?.sys_Timer;
  if (!timerApi?.setIntervalTimer) return false;

  const ok = timerApi.setIntervalTimer(TIMER_ID, POLL_INTERVAL_MS, () => {
    void pollOnce();
  });

  if (!ok) return false;

  usingNativeTimer = false;
  usingSysTimer = true;
  return true;
}

function stopIntervals(): void {
  if (nativeIntervalHandle) {
    try {
      clearInterval(nativeIntervalHandle);
    } catch {
      // ignore
    }
    nativeIntervalHandle = null;
  }

  if (usingSysTimer) {
    try {
      anyEda()?.sys_Timer?.clearIntervalTimer?.(TIMER_ID);
    } catch {
      // ignore
    }
  }

  usingNativeTimer = false;
  usingSysTimer = false;
}

async function ensureBridgeFiles(): Promise<void> {
  await ensureBridgeDir();
  const existing = await readTextFile(COMMAND_FILE);
  if (existing === undefined) {
    await writeTextFile(COMMAND_FILE, '');
  }
}

// ─── WebSocket transport ───

const EDA_WS_ID = 'jlc_bridge_ws';
let usingSysWs = false;

function wsCleanup(): void {
  if (wsReconnectHandle) {
    clearTimeout(wsReconnectHandle);
    wsReconnectHandle = null;
  }
  if (usingSysWs) {
    try { anyEda()?.sys_WebSocket?.close?.(EDA_WS_ID); } catch { /* ignore */ }
  }
  if (wsConnection) {
    try { wsConnection.close(); } catch { /* ignore */ }
    wsConnection = null;
  }
  wsConnected = false;
  usingSysWs = false;
}

function wsSend(data: Record<string, unknown>): void {
  const json = JSON.stringify(data);
  if (usingSysWs && wsConnected) {
    try { anyEda()?.sys_WebSocket?.send?.(EDA_WS_ID, json); return; } catch { /* fallthrough */ }
  }
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
  try { wsConnection.send(json); } catch { /* ignore */ }
}

function wsPushEvent(event: string, payload?: Record<string, unknown>): void {
  wsSend({ type: 'event', event, data: payload ?? {} });
}

async function handleWsMessage(raw: string): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  // Handle ping from gateway
  if (msg?.type === 'ping') {
    wsSend({ type: 'pong', id: msg.id, timestamp: Date.now(), payload: null });
    return;
  }

  // Handle command — support both flat and payload-wrapped formats
  if (msg?.type === 'command') {
    const action = msg.action ?? msg.payload?.action;
    const params = msg.params ?? msg.payload?.params ?? {};
    const cmdId = msg.id;
    if (!action || !cmdId) return;

    const cmd: BridgeCommand = {
      id: cmdId,
      action,
      params,
      timestamp: msg.timestamp ?? Date.now(),
    };
    lastCommandTime = cmd.timestamp;
    const result = await executeCommand(cmd);

    // Reply in gateway-expected format: { type: 'result', payload: { commandId, success, data, error } }
    wsSend({
      type: 'result',
      id: cmdId,
      timestamp: Date.now(),
      payload: {
        commandId: cmdId,
        success: result.success,
        data: result.data,
        error: result.error,
        durationMs: result.durationMs,
      },
    });
    log(`ws command done: ${cmd.action} -> ${result.success ? 'ok' : 'fail'}`);
  }
}

function scheduleWsReconnect(): void {
  if (wsReconnectHandle || !bridgeEnabled) return;
  wsReconnectHandle = setTimeout(() => {
    wsReconnectHandle = null;
    if (bridgeEnabled) {
      void connectWebSocket();
    }
  }, WS_RECONNECT_MS);
}

async function connectWebSocket(): Promise<boolean> {
  // Strategy 1: Use EDA's sys_WebSocket API (bypasses browser security restrictions)
  const sysWs = anyEda()?.sys_WebSocket;
  if (sysWs?.register) {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { resolve(false); }, 5000);
      try {
        sysWs.register(
          EDA_WS_ID,
          WS_URL,
          // onMessage
          (ev: MessageEvent) => {
            const data = typeof ev.data === 'string' ? ev.data : '';
            if (data) void handleWsMessage(data);
          },
          // onConnected
          () => {
            clearTimeout(timeout);
            usingSysWs = true;
            wsConnection = null; // not using native WS
            wsConnected = true;
            stopIntervals();
            log('ws connected via sys_WebSocket, file polling stopped');
            wsSend({ type: 'hello', name: APP_NAME, version: APP_VERSION });
            resolve(true);
          },
        );
      } catch (e) {
        clearTimeout(timeout);
        log(`sys_WebSocket failed: ${e instanceof Error ? e.message : String(e)}`);
        resolve(false);
      }
    });
  }

  // Strategy 2: Native WebSocket (may be blocked by EDA security)
  if (typeof WebSocket === 'undefined') return false;

  return new Promise<boolean>((resolve) => {
    try {
      const ws = new WebSocket(WS_URL);

      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolve(false);
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timeout);
        wsConnection = ws;
        wsConnected = true;
        usingSysWs = false;

        stopIntervals();
        log('ws connected via native WebSocket, file polling stopped');

        wsSend({ type: 'hello', name: APP_NAME, version: APP_VERSION });
        resolve(true);
      };

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (data) void handleWsMessage(data);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        const wasConnected = wsConnected;
        wsConnection = null;
        wsConnected = false;

        if (wasConnected && bridgeEnabled) {
          log('ws disconnected, falling back to file polling');
          const timerStarted = startSysInterval() || startNativeInterval();
          if (!timerStarted) {
            log('warning: could not restart file polling after ws disconnect');
          }
        }

        scheduleWsReconnect();

        if (!wasConnected) resolve(false);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
      };
    } catch {
      resolve(false);
    }
  });
}

async function startPolling(silent = false): Promise<void> {
  if (bridgeEnabled) return;

  await ensureBridgeFiles();
  bridgeEnabled = true;

  // Try WebSocket first
  const wsOk = await connectWebSocket();
  if (wsOk) {
    await saveEnabledPref(true);
    log(`bridge enabled (WebSocket)`);
    if (!silent) {
      showInfo([
        'Bridge enabled (WebSocket)',
        `WS endpoint: ${WS_URL}`,
        `Fallback: file polling`,
      ].join('\n'));
    }
    return;
  }

  // Fallback to file polling
  const timerStarted = startSysInterval() || startNativeInterval();
  if (!timerStarted) {
    bridgeEnabled = false;
    throw new Error('no available timer API (sys_Timer/setInterval)');
  }

  // Schedule WS reconnect in background
  scheduleWsReconnect();

  await saveEnabledPref(true);
  log(`bridge enabled (${getTimerMode()}, ws reconnecting in background)`);

  if (!silent) {
    showInfo([
      'Bridge enabled (file polling)',
      `Command file: ${COMMAND_FILE}`,
      `Result file: ${RESULT_FILE}`,
      `Poll interval: ${POLL_INTERVAL_MS}ms`,
      `Timer: ${getTimerMode()}`,
      `File API: ${getFileApiMode()}`,
      `WS: reconnecting in background...`,
    ].join('\n'));
  }
}

async function stopPolling(silent = false): Promise<void> {
  wsCleanup();
  stopIntervals();
  bridgeEnabled = false;
  await saveEnabledPref(false);
  log('bridge disabled');

  if (!silent) {
    showInfo('Bridge disabled');
  }
}

export function toggleBridge(): void {
  log('toggleBridge clicked');
  void (async () => {
    const enabled = bridgeEnabled || readEnabledPref();
    if (enabled) {
      await stopPolling();
      return;
    }

    try {
      await startPolling();
    } catch (error) {
      showError('Failed to enable bridge', error);
    }
  })();
}

export function showStatus(): void {
  log('showStatus clicked');
  void (async () => {
    const persisted = readEnabledPref();

    if (persisted && !bridgeEnabled) {
      try {
        await startPolling(true);
      } catch {
        // keep reporting stopped below
      }
    }

    const runtime = bridgeEnabled ? 'running' : 'stopped';
    const transport = wsConnected ? 'WebSocket' : (bridgeEnabled ? `file polling (${getTimerMode()})` : 'none');
    const lines = [
      `Runtime: ${runtime}`,
      `Transport: ${transport}`,
      `Persisted enabled: ${persisted ? 'yes' : 'no'}`,
      `Command file: ${COMMAND_FILE}`,
      `Result file: ${RESULT_FILE}`,
      `Poll interval: ${POLL_INTERVAL_MS}ms`,
      `Timer: ${getTimerMode()}`,
      `File API: ${getFileApiMode()}`,
      `WS: ${wsConnected ? 'connected' : 'disconnected'}`,
      `Last command time: ${lastCommandTime || '(none)'}`,
    ];
    showInfo(lines.join('\n'), `${APP_NAME} Status`);
  })();
}

export async function testCommand(): Promise<void> {
  log('testCommand clicked');
  try {
    showInfo('Reading PCB state...', `${APP_NAME} Test`);
    const state = await getPCBState();
    const preview = state.components
      .slice(0, 5)
      .map((c: any) => `${c.designator}: (${c.x.toFixed(1)}, ${c.y.toFixed(1)})`);

    showInfo(
      [
        'Test success',
        `Components: ${state.components.length}`,
        `Nets: ${state.nets.length}`,
        `Bounds: (${state.boardBounds.minX.toFixed(1)}, ${state.boardBounds.minY.toFixed(1)}) - (${state.boardBounds.maxX.toFixed(1)}, ${state.boardBounds.maxY.toFixed(1)})`,
        '',
        'Top 5 components:',
        ...preview,
      ].join('\n'),
      `${APP_NAME} Test`,
    );
  } catch (error) {
    showError('Test failed', error);
  }
}

// ─── EDA event push via WebSocket ───

export function notifyPcbChanged(detail?: Record<string, unknown>): void {
  if (!wsConnected) return;
  wsPushEvent('pcb_changed', detail);
}

export function notifySelectionChanged(detail?: Record<string, unknown>): void {
  if (!wsConnected) return;
  wsPushEvent('selection_changed', detail);
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
  void (async () => {
    try {
      await anyEda()?.sys_HeaderMenu?.replaceHeaderMenus?.((extensionConfig as any).headerMenus);
    } catch (error) {
      console.error(`[${APP_NAME}] replaceHeaderMenus failed`, error);
    }

    log(`plugin loaded (v${APP_VERSION})`);

    if (readEnabledPref()) {
      try {
        await startPolling(true);
        log('bridge auto-restored to running state');
      } catch (error) {
        showError('Auto-restore bridge failed', error);
      }
    } else {
      stopIntervals();
      bridgeEnabled = false;
    }
  })();
}
