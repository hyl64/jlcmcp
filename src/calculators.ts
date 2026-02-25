// 阻抗 & IPC-2221 线宽计算器 — 纯数学函数，不依赖 bridge

export type ImpedanceType = 'microstrip' | 'stripline' | 'diff_microstrip' | 'diff_stripline';

export interface ImpedanceParams {
  type: ImpedanceType;
  width: number;      // mil
  thickness?: number;  // mil, default 1.4 (1oz)
  height: number;      // mil, 介质厚度
  er?: number;         // 介电常数, default 4.3 (FR4)
  spacing?: number;    // mil, 差分间距（差分模式必填）
}

export interface ImpedanceResult {
  impedance: number;
  type: ImpedanceType;
  params: ImpedanceParams;
}

export interface WidthForImpedanceParams {
  type: ImpedanceType;
  targetImpedance: number; // Ω
  thickness?: number;
  height: number;
  er?: number;
  spacing?: number;        // 差分模式：固定间距求线宽
}

export interface WidthForImpedanceResult {
  width: number;
  impedance: number;
  error: number;           // 实际阻抗与目标的偏差 Ω
}

export interface TraceWidthParams {
  current: number;     // A
  thickness?: number;  // mil, default 1.4
  tempRise?: number;   // °C, default 10
  layer: 'external' | 'internal';
}

export interface TraceWidthResult {
  minWidth: number;    // mil
  crossSection: number; // mil²
  current: number;
  tempRise: number;
  layer: string;
}

/** 计算单端/差分阻抗 */
export function calcImpedance(params: ImpedanceParams): ImpedanceResult {
  const W = params.width;
  const T = params.thickness ?? 1.4;
  const H = params.height;
  const Er = params.er ?? 4.3;
  const S = params.spacing ?? 0;

  let Z0: number;

  switch (params.type) {
    case 'microstrip':
      Z0 = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
      break;
    case 'stripline':
      Z0 = (60 / Math.sqrt(Er)) * Math.log((4 * H) / (Math.PI * (W + T)));
      break;
    case 'diff_microstrip': {
      if (!params.spacing) throw new Error('差分微带线需要 spacing 参数');
      const Z0_single = (87 / Math.sqrt(Er + 1.41)) * Math.log(5.98 * H / (0.8 * W + T));
      Z0 = 2 * Z0_single * (1 - 0.48 * Math.exp(-0.96 * S / H));
      break;
    }
    case 'diff_stripline': {
      if (!params.spacing) throw new Error('差分带状线需要 spacing 参数');
      Z0 = (120 / Math.sqrt(Er)) * Math.log((2 * H) / (Math.PI * (W + T + S)));
      break;
    }
    default:
      throw new Error(`未知阻抗类型: ${params.type}`);
  }

  return { impedance: Math.round(Z0 * 100) / 100, type: params.type, params };
}

/** 二分法反算线宽：给定目标阻抗，求满足条件的线宽 */
export function calcWidthForImpedance(params: WidthForImpedanceParams): WidthForImpedanceResult {
  const target = params.targetImpedance;
  let lo = 0.5;   // mil
  let hi = 200;    // mil
  const maxIter = 100;
  const tolerance = 0.01; // Ω

  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const z = calcImpedance({ ...params, width: mid } as ImpedanceParams).impedance;
    if (Math.abs(z - target) < tolerance) {
      return { width: Math.round(mid * 100) / 100, impedance: z, error: Math.round((z - target) * 100) / 100 };
    }
    // 线宽越大阻抗越小，所以 z > target 时需要增大线宽
    if (z > target) lo = mid;
    else hi = mid;
  }

  // 返回最佳近似
  const finalW = (lo + hi) / 2;
  const finalZ = calcImpedance({ ...params, width: finalW } as ImpedanceParams).impedance;
  return {
    width: Math.round(finalW * 100) / 100,
    impedance: finalZ,
    error: Math.round((finalZ - target) * 100) / 100,
  };
}

/** IPC-2221 线宽计算：给定电流，求最小线宽 */
export function calcTraceWidth(params: TraceWidthParams): TraceWidthResult {
  const I = params.current;
  const T_copper = params.thickness ?? 1.4; // mil
  const dT = params.tempRise ?? 10;         // °C
  const layer = params.layer;

  // IPC-2221 公式: I = k × ΔT^b × A^c
  const k = layer === 'external' ? 0.048 : 0.024;
  const b = 0.44;
  const c = 0.725;

  // 反算截面积: A = (I / (k × ΔT^b))^(1/c)  单位 mil²
  const A = Math.pow(I / (k * Math.pow(dT, b)), 1 / c);

  // 线宽 = 截面积 / 铜厚
  const W = A / T_copper;

  return {
    minWidth: Math.round(W * 100) / 100,
    crossSection: Math.round(A * 100) / 100,
    current: I,
    tempRise: dT,
    layer,
  };
}
