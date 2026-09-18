import { fileURLToPath } from 'node:url';

/**
 * 不从 `vitest/config` 取 `defineConfig`:装了依赖固然能解析到 `vitest`,但这个包也支持
 * 不装依赖、借平级框架 checkout 的 vitest 运行,那时这个说明符在本目录解析不到。
 * 纯对象配置两种情形都被识别,所以不引它。
 */
const FRAMEWORK_SRC = fileURLToPath(new URL('../Cortico/src/', import.meta.url));

export default {
  resolve: {
    alias: [{ find: /^cortico\//, replacement: FRAMEWORK_SRC }],
  },
  server: {
    fs: { allow: [fileURLToPath(new URL('./', import.meta.url)), FRAMEWORK_SRC] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    env: { CORTICO_LANGUAGE: 'zh' },
    testTimeout: 20000,
    pool: 'forks' as const,
  },
};
