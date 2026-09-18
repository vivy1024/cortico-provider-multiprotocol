import type { BaseProvider, ProviderModule } from 'cortico/providers/base.ts';
import type { Logger } from 'cortico/core/types.ts';
import type { PriceDefinition } from 'cortico/providers/pricebook.ts';
import { isContextOverflow } from 'cortico/providers/transport/errors.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import { ModelCatalog } from './catalog.ts';
import { gatewayConsole } from './console/server.ts';
import { Gateway } from './gateway.ts';
import { ChatCompletionsProvider } from './native.ts';
import { AnthropicProvider } from './anthropic/client.ts';
import { DEFAULT_PROTOCOL, IMPLEMENTED, PROTOCOLS, endpointPathFor, isAnthropic, isProtocol, readProtocol, type Protocol } from './protocols.ts';
import { text } from './console/strings.ts';

/** 控制台在推理强度格下提示的候选;`reasoningTiers` 为空表示这一格仍收任意非空串。 */
const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

interface DelegateDeps {
  baseUrl: string;
  apiKey?: string;
  options: Record<string, unknown> | undefined;
  log: Logger;
  media: { enabled: () => boolean; read: (handle: string) => Buffer | null };
  keepThinking: () => boolean;
}

/** 协议选一条 wire。没有实现的协议在这里报错,`availability` 会先一步把它挡在生成之外。 */
function createDelegate(protocol: Protocol, deps: DelegateDeps): BaseProvider {
  const { baseUrl, apiKey, options, log, media, keepThinking } = deps;
  if (protocol === 'responses-compatible') {
    return new ResponsesProvider({
      baseUrl,
      apiKey,
      endpointPath: endpointPathFor(protocol, options),
      ...(isRecord(options?.extraHeaders) ? { extraHeaders: options.extraHeaders as Record<string, string> } : {}),
      ...(isRecord(options?.extraBody) ? { extraBody: options.extraBody } : {}),
      log,
      media,
      keepThinking,
    });
  }
  if (isAnthropic(protocol)) {
    return new AnthropicProvider({
      baseUrl,
      apiKey,
      endpointPath: endpointPathFor(protocol, options),
      official: protocol === 'anthropic-official',
      ...(isRecord(options?.extraHeaders) ? { extraHeaders: options.extraHeaders as Record<string, string> } : {}),
      log,
    });
  }
  if (protocol === 'completions-compatible') {
    return new ChatCompletionsProvider({ baseUrl, apiKey, log, media });
  }
  throw new Error(`protocol ${protocol}: no wire implementation in this package`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 按网关身份共享的目录。`prices()` 挂在模块上而不是实例上,拿不到 `create()` 里那份,
 * 所以在这里按 (地址, 密钥变量名) 存一份;同一网关的多个端点读同一个目录。
 */
const catalogs = new Map<string, ModelCatalog>();

/** 目录的身份:同一地址同一密钥算同一个网关。两处取用共用它,免得键的拼法漂移。 */
function catalogKey(baseUrl: string, secret: string | undefined): string {
  return JSON.stringify([baseUrl, secret ?? '']);
}

function catalogFor(baseUrl: string, secret: string | undefined, headers: () => Record<string, string>): ModelCatalog {
  const key = catalogKey(baseUrl, secret);
  let catalog = catalogs.get(key);
  if (!catalog) {
    catalog = new ModelCatalog(() => ({ baseUrl, headers: headers() }));
    catalogs.set(key, catalog);
  }
  return catalog;
}

const PROVIDER = {
  id: 'multiprotocol',
  title: '多协议端点',
  defaultBaseUrl: 'https://api.openai.com/v1',
  baseUrlSuggestions: [
    'https://api.openai.com/v1',
    'https://openrouter.ai/api/v1',
    'http://127.0.0.1:8080/v1',
  ],
  reasoningTiers: [],
  effortSuggestions: EFFORTS,
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  console: gatewayConsole,
  /**
   * 网关自报的价目。端点条目里自填的报价优先级更高,框架会用它覆盖同一计价口径,
   * 所以这里只管把目录里的那份交出去。
   */
  prices(entry, request) {
    const model = request.model;
    if (typeof model !== 'string' || !model) return [];
    const pricing = catalogs.get(catalogKey(entry.baseUrl, entry.secret))?.pricing(model);
    if (!pricing) return [];
    return [{
      models: [model],
      currency: pricing.currency,
      basis: 'marginal',
      rules: pricing.rules as PriceDefinition['rules'],
      source: 'gateway catalog',
    }];
  },
  /** 协议写在 `options.protocol`;认不出的值当场拒绝,不留到调用时才发现。 */
  validateEntry(entry, language) {
    const S = text(language);
    const value = entry.options?.protocol;
    if (value !== undefined && !isProtocol(value)) {
      throw new Error(S.protocolUnknown(String(value), PROTOCOLS.join(' / ')));
    }
  },
  /** 判断只看本地状态:选了这个包还没实现的协议,开播前就说清楚,不到生成时才抛。 */
  availability(_name, entry, language) {
    const protocol = readProtocol(entry.options);
    if (IMPLEMENTED.includes(protocol)) return { ready: true };
    const S = text(language);
    return { ready: false, reason: S.protocolNotImplemented(protocol, IMPLEMENTED.join(' / ')) };
  },
  create(name, entry, host) {
    // 密钥只认宿主的密钥表。`entry.secret` 是变量名而不是值:拿它当 token 会让配置文件
    // 变成密钥的存放处,还会在变量名拼错时把名字本身当凭据发到网关。
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const protocol = readProtocol(entry.options);
    // 条目自带的请求头同时用于目录与生成。有的网关拿某个自定义头决定 `GET /models` 回什么:
    // 带上它才给出上下文窗口、原生协议与价目,不认得的端点忽略它,回自己的标准列表。
    // 这类头是端点的事实,写在条目里而不是包里。
    const extraHeaders = isRecord(entry.options?.extraHeaders)
      ? (entry.options.extraHeaders as Record<string, string>)
      : {};
    const endpoint = (): { baseUrl: string; headers: Record<string, string> } => ({
      baseUrl: entry.baseUrl,
      headers: { ...extraHeaders, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    const catalog = catalogFor(entry.baseUrl, entry.secret, () => endpoint().headers);
    // 价目要在生成那一刻同步取用,这里先把目录取回来;取不到不挡启动,报价回落到端点自填的。
    void catalog.prime();
    return {
      /**
       * 协议与请求路径进兼容域:推理凭据(thinking signature、encrypted_content)只对
       * 产出它的那条 wire 有效,换协议后旧 session 不能拿旧凭据重放。
       */
      compatibilityKey: () => [protocol, endpointPathFor(protocol, entry.options), name],
      control: { gateway: new Gateway(endpoint) },
      listModels: () => catalog.list(),
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
export { PROVIDER, DEFAULT_PROTOCOL };
