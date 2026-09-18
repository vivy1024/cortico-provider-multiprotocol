# cortico-provider-multiprotocol

Owner: `src/index.ts`

多协议 provider:同一个端点地址,按条目上的 `options.protocol` 选一条 wire 说话。
HTTP / SSE、重试退避、计量、流装配、终态判定全在框架的 `providers/transport/`;这个包只回答
三个问题:请求体长什么样、请求头带什么、上游的流怎么装回标准事件。

模块不记任何厂商事实——地址、密钥、模型名、价目、自定义请求头都在部署的端点条目里。

## 协议

`src/protocols.ts` 声明 7 条,本包实现其中 4 条:

| 协议 | 默认路径 | 状态 |
|---|---|---|
| `completions-compatible` | `/chat/completions` | ✅ `src/native.ts` |
| `responses-compatible` | `/responses` | ✅ 框架的 `ResponsesProvider` |
| `anthropic-compatible` | `/messages` | ✅ `src/anthropic/` |
| `anthropic-official` | `/messages` | ✅ 同上,对话中段保留 `system` 角色 |
| `codex-native` | `/responses` | ❌ 未实现 |
| `gemini-generate-content` | `/responses` | ❌ 未实现 |
| `gemini-interactions` | `/responses` | ❌ 未实现 |

声明而未实现的协议由 `availability()` 在开播前挡下并说明,不留到生成时才抛。
`endpointPath` 可在条目里覆盖默认路径:经网关时通常要写成网关挂载该协议的那一段。

协议与请求路径进 `compatibilityKey`:推理凭据(thinking signature、`encrypted_content`)
只对产出它的那条 wire 有效,换协议后旧 session 不会拿旧凭据重放。

## 文件

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:id、档位表、`prices()`、`validateEntry()`、`availability()`、`create()` |
| `src/protocols.ts` | 协议清单、实现清单、端点路径规则 |
| `src/catalog.ts` | 端点自报的模型目录:列表、上下文窗口、价目 |
| `src/gateway.ts` | 面板用的网关探针 |
| `src/native.ts` | Chat Completions 方言客户端 |
| `src/anthropic/` | Anthropic Messages 方言:`body` / `client` / `assembly` / `tools` |
| `src/console/` | 控制台面板:`server.ts` 取状态与改协议,`client.ts` 打成 `dist/console.js` |
| `tests/` | 干装载、请求体形状、流装配、价目换算、面板契约 |

## 安装与装载 (Installation)

在 Cortico 项目的 `extensions/` 目录下（或直接在 Cortico 根目录），通过 GitHub 直接安装：

```bash
pnpm add -D github:vivy1024/cortico-provider-multiprotocol
```

或者在 Cortico 的 `extensions/package.json` 的 `dependencies` / `devDependencies` 中声明：

```json
{
  "dependencies": {
    "cortico-provider-multiprotocol": "github:vivy1024/cortico-provider-multiprotocol"
  }
}
```

随后在 `extensions/` 目录下运行 `pnpm install` 即可自动装载并生效。

## 装进实例后该看见什么

LLM 设置页多一个 `multiprotocol` 端点类型。填好地址与密钥变量名后,实例设置面板里能:

- 看到端点探针结果与当前协议,直接切换协议(存进 `options.protocol`,实例随后重建);
- 拉取模型列表,带上下文窗口;
- 按端点自报的价目计费——`prices()` 交出目录里那份,条目上自填的报价优先级更高。

## 条目上的配置

```jsonc
{
  "kind": "multiprotocol",
  "baseUrl": "https://example.com/v1",
  "secret": "MY_API_KEY",            // 变量名,不是值
  "options": {
    "protocol": "anthropic-compatible",
    "endpointPath": "/anthropic/messages",
    "extraHeaders": { "X-Example": "1" },
    "extraBody": {}
  }
}
```

`extraHeaders` 同时用于 `GET /models` 与生成请求。有的网关靠某个自定义头决定模型目录回什么
——带上它才给出上下文窗口、每个模型的原生协议与价目;不认得这个头的端点忽略它,回自己的
标准列表。这类头是端点的事实,写在条目里,不进包。

## 密钥

`entry.secret` 是**变量名**,值由宿主从部署的 `.env` 解析。不要把 token 直接写进 `config.json`。

## 开发

```bash
corepack pnpm install
pnpm test
pnpm typecheck
pnpm build          # src/console/client.ts → dist/console.js
```

`tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 alias 都指向平级的框架 checkout
(`../Cortico`),按你的实际位置改。运行时不靠它们:框架 `src/extensions/runtime.ts` 的
模块钩子会把 `cortico/*` 解析到框架源码本身。浏览器侧对 `cortico/*` 只能 `import type`。

不单独装依赖也能跑:`vitest.config.ts` 与 `scripts/build-console.mjs` 会回落到
`../Cortico/node_modules`,此时用框架 checkout 里的 vitest 与 esbuild。

校验(在框架仓库根下):

```bash
pnpm check:extension ../cortico-provider-multiprotocol
```

规矩见 [docs/extensions.md](../Cortico/docs/extensions.md) 与
[docs/providers.md](../Cortico/docs/providers.md)。
