/**
 * 面板 bundle。与框架只有一条依赖:`client-panel.ts` 里的类型——浏览器侧只
 * `import type`,运行期的数据一律走 `ctx.invoke`,DOM 一律用 `ctx.ui` 的原语,
 * 定时器走 `ctx.interval`。
 */
import type { ConsoleClientBundle } from 'cortico/web/shared/client-panel.ts';
import { gatewayPanel } from './gateway-panel.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    gateway: gatewayPanel,
  },
};

export default bundle;
