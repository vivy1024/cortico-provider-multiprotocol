import type { BaseProvider, ProviderModule } from 'cortico/providers/base.ts';
import type { Logger } from 'cortico/core/types.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import { ModelCatalog } from './catalog.ts';
import { moduleConfig } from './config.ts';
import { ChatCompletionsProvider } from './native.ts';
import { AnthropicProvider } from './anthropic/client.ts';
import { PROTOCOLS, endpointPathFor, isKnownProtocol, migrateOptions, readProtocol, type Protocol } from './protocols.ts';
import { text } from './strings.ts';

/** 控制台在推理强度格下提示的候选;`reasoningTiers` 为空表示这一格仍收任意非空串。 */
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordOf<T>(value: unknown): Record<string, T> | undefined {
  return isRecord(value) ? (value as Record<string, T>) : undefined;
}

interface DelegateDeps {
  baseUrl: string;
  apiKey?: string;
  options: Record<string, unknown> | undefined;
  log: Logger;
  media: { enabled: () => boolean; read: (handle: string) => Buffer | null };
  keepThinking: () => boolean;
}

/** 协议选一条 wire;三条都收同一组路径、请求头与请求体配置。 */
function createDelegate(protocol: Protocol, deps: DelegateDeps): BaseProvider {
  const { baseUrl, apiKey, options, log, media, keepThinking } = deps;
  const shared = {
    baseUrl,
    apiKey,
    endpointPath: endpointPathFor(protocol, options),
    extraHeaders: recordOf<string>(options?.extraHeaders),
    extraBody: recordOf<unknown>(options?.extraBody),
    log,
    media,
  };
  if (protocol === 'openai-responses') return new ResponsesProvider({ ...shared, keepThinking });
  if (protocol === 'anthropic-messages') {
    return new AnthropicProvider({ ...shared, keepThinking, systemInHistory: options?.systemInHistory === true });
  }
  return new ChatCompletionsProvider(shared);
}

/**
 * 按端点身份共享的目录。`prices()` 挂在模块上而不是实例上,拿不到 `create()` 里那份,
 * 所以在这里按 (地址, 密钥变量名, 目录请求头) 存一份。
 */
const catalogs = new Map<string, ModelCatalog>();

function catalogKey(baseUrl: string, secret: string | undefined, options: Record<string, unknown> | undefined): string {
  return JSON.stringify([baseUrl, secret ?? '', options?.catalogHeaders ?? null]);
}

function catalogFor(key: string, endpoint: () => { baseUrl: string; headers: Record<string, string> }): ModelCatalog {
  let catalog = catalogs.get(key);
  if (!catalog) {
    catalog = new ModelCatalog(endpoint);
    catalogs.set(key, catalog);
  }
  return catalog;
}

const PROVIDER = {
  id: 'multiprotocol',
  title: 'Multi-protocol',
  description: 'OpenAI Chat Completions、OpenAI Responses、Anthropic Messages,按端点选一种。',
  describe: {
    // 三种 wire 的选择就是 PROTOCOLS;协议名以这里为准,不自造简写。
    protocols: [...PROTOCOLS],
    // 密钥由端点条目里的 `secret` 变量名经宿主密钥表读取,没有其他登录流程。
    auth: ['api-key'],
    // 发往端点配置的 HTTP 服务,模型默认不在本机运行。
    local: false,
    // 三条 wire 都只在 entry.multimodal 打开时把历史里的图像分片送上游,没有音频/视频。
    input: ['text', 'image'],
  },
  defaultBaseUrl: 'https://api.openai.com/v1',
  baseUrlSuggestions: [
    'https://api.openai.com/v1',
    'https://api.anthropic.com/v1',
    'https://openrouter.ai/api/v1',
    'http://127.0.0.1:8080/v1',
  ],
  reasoningTiers: [],
  effortSuggestions: EFFORTS,
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  config: moduleConfig,
  normalize(entry) {
    const options = migrateOptions(entry.options);
    return options === entry.options ? entry : { ...entry, options };
  },
  /** 协议写在 `options.protocol`;认不出的值当场拒绝,不留到调用时才发现。 */
  validateEntry(entry, language) {
    const value = entry.options?.protocol;
    if (value !== undefined && !isKnownProtocol(value)) {
      throw new Error(text(language).protocolUnknown(String(value), PROTOCOLS.join(' / ')));
    }
  },
  /**
   * 模型列表附带的价格。端点条目里自填的报价优先级更高,框架会用它覆盖同一计价口径;
   * 条目没声明 `catalogCurrency` 时不采用列表价格,币种不靠猜。
   */
  prices(entry, request) {
    const model = request.model;
    const currency = typeof entry.options?.catalogCurrency === 'string' ? entry.options.catalogCurrency.trim() : '';
    if (typeof model !== 'string' || !model || !currency) return [];
    const pricing = catalogs.get(catalogKey(entry.baseUrl, entry.secret, entry.options))?.pricing(model, currency);
    if (!pricing) return [];
    return [{
      models: [model],
      currency: pricing.currency,
      basis: 'marginal',
      rules: pricing.rules as PriceDefinition['rules'],
      ...(pricing.inputBands ? { inputBands: pricing.inputBands as PriceDefinition['inputBands'] } : {}),
      source: 'model list',
    }];
  },
  create(name, entry, host) {
    // 密钥只认宿主的密钥表。`entry.secret` 是变量名而不是值。
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const protocol = readProtocol(entry.options);
    // 目录请求头只用于 `GET /models`:有的端点据此返回带上下文窗口与价格的目录,
    // 生成请求不带它,免得端点按目录客户端对待生成流。
    const headers = (extra: Record<string, string> | undefined): Record<string, string> => ({
      ...recordOf<string>(entry.options?.extraHeaders),
      ...extra,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    });
    const catalog = catalogFor(catalogKey(entry.baseUrl, entry.secret, entry.options), () => ({
      baseUrl: entry.baseUrl,
      headers: headers(recordOf<string>(entry.options?.catalogHeaders)),
    }));
    // 价目要在生成那一刻同步取用,这里先把目录取回来;取不到不挡启动,报价回落到端点自填的。
    void catalog.prime();
    return {
      /**
       * 协议与请求路径进兼容域:推理凭据(thinking signature、encrypted_content)只对
       * 产出它的那条 wire 有效,换协议后旧 session 不能拿旧凭据重放。
       */
      compatibilityKey: () => [protocol, endpointPathFor(protocol, entry.options), name],
      listModels: () => catalog.list(protocol),
      contextWindow: (model) => catalog.contextWindow(model),
      client: createDelegate(protocol, {
        baseUrl: entry.baseUrl,
        apiKey,
        options: entry.options,
        log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob },
        keepThinking: host.keepThinking,
      }),
    };
  },
} satisfies ProviderModule;

export default PROVIDER;
export { PROVIDER };
