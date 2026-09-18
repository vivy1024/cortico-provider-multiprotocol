/**
 * 面板 bundle:`src/console/client.ts` → `dist/console.js`。产物名写死在 package.json 的
 * `cortico.consoleClient` 里,服务端自己给它分配 URL。
 *
 * 不给 `cortico/*` 配 alias 也不 external:浏览器侧只允许 `import type` 框架,那些 import
 * 编译期就被擦掉。构建若报 "Could not resolve cortico/…",说明有一处运行时依赖漏网,
 * 去把它本地化,而不是在这里放行。
 *
 * esbuild 先从本包解析;这个包平时不单独装依赖,那时回落到平级的框架 checkout。
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = `${root}dist`;

function loadEsbuild() {
  for (const base of [import.meta.url, new URL('../../Cortico/', import.meta.url).href]) {
    try {
      return createRequire(base)('esbuild');
    } catch {
      // 下一个候选位置。
    }
  }
  throw new Error('找不到 esbuild:在本包装依赖,或把框架 checkout 放在 ../Cortico');
}

const esbuild = loadEsbuild();

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await esbuild.build({
  entryPoints: [{ in: `${root}src/console/client.ts`, out: 'console' }],
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: true,
  sourcemap: true,
  metafile: true,
});

for (const [path, info] of Object.entries(result.metafile.outputs)) {
  if (path.endsWith('.map')) continue;
  console.log(`${path.replace(/\\/g, '/')}  ${(info.bytes / 1024).toFixed(1)} KB`);
}
