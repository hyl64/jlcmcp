/**
 * codegen.ts
 *
 * 动作 → 官方 Bridge 执行代码。每个动作生成一段在嘉立创EDA专业版内执行的
 * (async () => {...})() 代码字符串（由官方 Run API Gateway 扩展以
 * new AsyncFunction('eda', code) 执行，eda 为扩展 API 全局对象）。
 *
 * - 32 个经典动作来自 legacy-jlc-bridge 移植（src/codegen/generated.ts）
 * - ping / select_component / delete_selected 为内联实现
 * - 高级工具可直接通过 executeRaw 传入自定义代码
 */
import { GENERATED_ACTIONS, SUPPORTED_ACTIONS } from './codegen/generated.js';

export { SUPPORTED_ACTIONS };

export function actionToCode(action: string, params: Record<string, unknown> = {}): string {
  switch (action) {
    case 'ping':
      return `return (async () => { return { message: 'pong', timestamp: Date.now() }; })();`;

    case 'select_component': {
      const designator = String(params?.designator ?? '').trim();
      if (!designator) throw new Error('designator is required');
      return `return (async () => {
  const api = eda;
  if (!api?.pcb_SelectControl?.selectByDesignator) {
    throw new Error('select not supported');
  }
  await api.pcb_SelectControl.selectByDesignator(${JSON.stringify(designator)});
  return { selected: ${JSON.stringify(designator)} };
})()`;
    }

    case 'delete_selected':
      return `return (async () => {
  const api = eda;
  if (!api?.pcb_SelectControl?.deleteSelected) {
    throw new Error('delete not supported');
  }
  await api.pcb_SelectControl.deleteSelected();
  return { deleted: true };
})()`;

    default:
      break;
  }

  const tpl = GENERATED_ACTIONS[action];
  if (!tpl) {
    throw new Error(`unknown action: ${action} (supported: ${SUPPORTED_ACTIONS.join(', ')})`);
  }
  const paramsJson = JSON.stringify(params ?? {});
  return `return (async () => {
${tpl.pre}

const params = ${paramsJson};
return await (${tpl.rootJs})(params);
})()`;
}
