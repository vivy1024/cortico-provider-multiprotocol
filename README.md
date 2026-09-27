# cortico-provider-multiprotocol

Owner: `src/index.ts`

Cortico 的多协议 provider:一个端点按 `options.protocol` 说 OpenAI Chat Completions、
OpenAI Responses 或 Anthropic Messages。HTTP / SSE、重试退避、计量、流装配与终态判定都在框架的
`providers/transport/`;这个包负责三件事:请求体怎么构造、请求头带什么、上游的流怎么装回标准事件。

模块不记厂商事实:地址、密钥、模型名、价目与自定义请求头都在部署的端点条目里。

## 协议

| `options.protocol` | 默认路径 | 实现 |
|---|---|---|
| `openai-chat-completions`(缺省) | `/chat/completions` | `src/native.ts` |
| `openai-responses` | `/responses` | 框架的 `ResponsesProvider` |
| `anthropic-messages` | `/messages` | `src/anthropic/` |

`endpointPath` 覆盖默认路径,三种协议都认。`anthropic-messages` 下 `systemInHistory` 为真时,
对话中段的 system 消息保留 `system` 角色(官方接口接受);为假时以 `user` 角色发出,位置不变。

0.1 的取值 `completions-compatible`、`responses-compatible`、`anthropic-compatible`、
`anthropic-official` 仍能读取,装载时换成上面的取值。

协议与请求路径进 `compatibilityKey`:推理凭据(thinking signature、`encrypted_content`)只对产出它
的那条 wire 有效,换协议后旧 session 不会拿旧凭据重放。

### Anthropic Messages

- 历史按 Core 的上下文记录渲染:思考块带原文与签名重放,只回给产出它的实例、模块、兼容域与模型;
  `keepThinking` 关时只保留合成开头的那一段。`redacted_thinking` 原样重放。
- 附件图片(用户消息与工具结果里的)在端点声明接受图片时以 base64 块发出。
- 顶层 `system` 带 `cache_control`,支持提示缓存的上游按缓存价计费。

## 模型列表

`GET <baseUrl>/models` 读两种形状:OpenAI 的 `data[]`,以及带元数据的 `models[]`。后者里认这些字段:

| 字段 | 用法 |
|---|---|
| `contextWindow` / `context_length` / `contextLength` | 上下文窗口 |
| `available: false` | 不列出 |
| `protocol` | 建议客户端用的协议(`anthropic`、`responses`、`openai` 等);标了的模型只在对应协议下列出 |
| `pricing` | 条目声明了 `catalogCurrency` 时作为价目;只认按 token 计价 |

`catalogHeaders` 只随 `GET /models` 发出。有的端点据某个请求头决定是否返回带元数据的目录,
这个头写在这里,生成请求不带它。

## 条目上的配置

```jsonc
{
  "kind": "multiprotocol",
  "baseUrl": "https://example.com/v1",
  "secret": "MY_API_KEY",              // 变量名,不是值
  "options": {
    "protocol": "anthropic-messages",
    "endpointPath": "/messages",       // 可省
    "systemInHistory": false,
    "extraHeaders": { "X-Example": "1" },  // 每个请求都带
    "catalogHeaders": {},              // 只在获取模型列表时带
    "extraBody": {},                   // 并入每次生成请求
    "catalogCurrency": "USD"           // 采用模型列表里的价格时的币种
  }
}
```

这些项都在控制台端点编辑页里:协议、中段 system 与目录币种在「模型与生成」之后的「协议」一段,
请求路径与三个 JSON 对象在高级一段。

## 文件

| 文件 | 内容 |
|---|---|
| `src/index.ts` | `ProviderModule`:`config()`、`normalize()`、`validateEntry()`、`prices()`、`create()` |
| `src/config.ts` | 模块配置项 |
| `src/protocols.ts` | 协议清单、旧取值迁移、请求路径、目录的协议建议 |
| `src/catalog.ts` | 模型列表、上下文窗口、价目 |
| `src/native.ts` | Chat Completions 客户端 |
| `src/anthropic/` | Anthropic Messages:`body` / `client` / `assembly` / `tools` |

## 安装

在 Cortico 的 `extensions/` 目录下:

```bash
pnpm add github:vivy1024/cortico-provider-multiprotocol
```

重启 bot 进程后装载。

## 开发

```bash
corepack pnpm install
pnpm test
pnpm typecheck
```

`tsconfig.json` 的 `paths` 与 `vitest.config.ts` 的 alias 指向平级的框架 checkout(`../Cortico`)。
运行时由框架的模块钩子把 `cortico/*` 解析到框架源码。

在框架仓库根下校验:

```bash
pnpm check:extension ../cortico-provider-multiprotocol
```

规矩见 Cortico 的 `docs/extensions.md` 与 `docs/providers.md`。
