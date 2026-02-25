import { z } from 'zod';
import {
  calcImpedance,
  calcWidthForImpedance,
  calcTraceWidth,
  type ImpedanceType,
} from '../calculators.js';

export function registerCalculatorTools(server: any) {
  server.tool(
    'calc_impedance',
    '计算 PCB 走线阻抗，或根据目标阻抗反算线宽。支持微带线/带状线/差分模式',
    {
      type: z.enum(['microstrip', 'stripline', 'diff_microstrip', 'diff_stripline']).describe('走线类型'),
      width: z.number().optional().describe('线宽 (mil)，与 targetImpedance 二选一'),
      targetImpedance: z.number().optional().describe('目标阻抗 (Ω)，填此项则反算线宽'),
      thickness: z.number().optional().describe('铜厚 (mil)，默认 1.4 (1oz)'),
      height: z.number().describe('介质厚度 (mil)'),
      er: z.number().optional().describe('介电常数，默认 4.3 (FR4)'),
      spacing: z.number().optional().describe('差分间距 (mil)，差分模式必填'),
    },
    async (args: {
      type: ImpedanceType;
      width?: number;
      targetImpedance?: number;
      thickness?: number;
      height: number;
      er?: number;
      spacing?: number;
    }) => {
      try {
        if (args.targetImpedance !== undefined) {
          // 反算线宽模式
          const result = calcWidthForImpedance({
            type: args.type,
            targetImpedance: args.targetImpedance,
            thickness: args.thickness,
            height: args.height,
            er: args.er,
            spacing: args.spacing,
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                mode: 'reverse',
                targetImpedance: args.targetImpedance,
                recommendedWidth: result.width,
                actualImpedance: result.impedance,
                error: result.error,
                unit: 'mil / Ω',
              }, null, 2),
            }],
          };
        }

        if (args.width === undefined) {
          return {
            content: [{ type: 'text' as const, text: '错误：需要提供 width 或 targetImpedance' }],
            isError: true,
          };
        }

        // 正向计算阻抗
        const result = calcImpedance({
          type: args.type,
          width: args.width,
          thickness: args.thickness,
          height: args.height,
          er: args.er,
          spacing: args.spacing,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              mode: 'forward',
              impedance: result.impedance,
              type: result.type,
              unit: 'Ω',
              params: result.params,
            }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `计算错误：${e.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'calc_trace_width',
    '根据载流要求计算最小走线宽度 (IPC-2221)',
    {
      current: z.number().describe('电流 (A)'),
      thickness: z.number().optional().describe('铜厚 (mil)，默认 1.4 (1oz)'),
      tempRise: z.number().optional().describe('允许温升 (°C)，默认 10'),
      layer: z.enum(['external', 'internal']).optional().describe('走线层类型，默认 external'),
    },
    async (args: {
      current: number;
      thickness?: number;
      tempRise?: number;
      layer?: 'external' | 'internal';
    }) => {
      try {
        const result = calcTraceWidth({
          current: args.current,
          thickness: args.thickness,
          tempRise: args.tempRise,
          layer: args.layer ?? 'external',
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              minWidth: result.minWidth,
              crossSection: result.crossSection,
              current: result.current,
              tempRise: result.tempRise,
              layer: result.layer,
              unit: 'mil',
            }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `计算错误：${e.message}` }],
          isError: true,
        };
      }
    },
  );
}
