/**
 * 端点的模型目录。`GET /models` 有两种回应形状:OpenAI 标准的 `data[]` 只列 id,
 * 带目录元数据的网关回 `models[]`,其中的上下文窗口直接可用。两种都读,取到什么算什么。
 */

export interface CatalogModel {
  id: string;
  contextWindow?: number;
}

export interface CatalogEndpoint {
  baseUrl: string;
  headers: Record<string, string>;
}

/** 目录里表示上下文窗口的字段名;不同实现用不同拼写,先命中的算数。 */
const WINDOW_KEYS = ['contextWindow', 'context_length', 'contextLength'] as const;

function readWindow(row: Record<string, unknown>): number | undefined {
  for (const key of WINDOW_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Code-point 比较,不是 `localeCompare`:这里排的是模型 id 这种技术标识符,
 * `localeCompare` 按运行时区域解析,同一份目录在不同区域下顺序会变。
 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 目录报的计价口径 → 框架的计量名。目录没有的口径不出现在规则里。 */
const METER_BY_FIELD: ReadonlyArray<[string, string]> = [
  ['input', 'uncachedInput'],
  ['output', 'output'],
  ['cacheReadInput', 'cachedInput'],
  ['cacheCreationInput', 'detail:cacheCreationInput'],
];

export interface CatalogPricing {
  currency: string;
  rules: Array<{ meter: string; perMillion: number }>;
}

/** 币种按目录的单位名判定;认不出的单位名不猜,留空由调用方决定要不要报价。 */
function currencyOf(unitName: unknown): string | undefined {
  if (typeof unitName !== 'string') return undefined;
  if (unitName.includes('元')) return 'CNY';
  if (/usd|dollar|\$/i.test(unitName)) return 'USD';
  return undefined;
}

/**
 * 目录条目里的价目。`tokenUnit` 是这套价格按多少 token 计的,框架统一按百万 token,
 * 所以要换算;倍率如果目录给了就乘进去,它是这条通道的实际折算。
 */
function readPricing(row: Record<string, unknown>): CatalogPricing | undefined {
  const raw = row.pricing;
  if (!raw || typeof raw !== 'object') return undefined;
  const pricing = raw as Record<string, unknown>;
  if (pricing.billable === false || pricing.pricingConfigured === false) return undefined;
  const currency = currencyOf(pricing.unitName);
  if (!currency) return undefined;
  const unit = typeof pricing.tokenUnit === 'number' && pricing.tokenUnit > 0 ? pricing.tokenUnit : 1_000_000;
  const multiplier = typeof pricing.multiplier === 'number' && pricing.multiplier > 0 ? pricing.multiplier : 1;
  const scale = (1_000_000 / unit) * multiplier;
  const rules: CatalogPricing['rules'] = [];
  for (const [field, meter] of METER_BY_FIELD) {
    const value = pricing[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      rules.push({ meter, perMillion: value * scale });
    }
  }
  return rules.length > 0 ? { currency, rules } : undefined;
}

export class ModelCatalog {
  private readonly known = new Map<string, number | undefined>();
  private readonly prices = new Map<string, CatalogPricing>();

  constructor(
    private readonly endpoint: () => CatalogEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(): Promise<CatalogModel[]> {
    const { baseUrl, headers } = this.endpoint();
    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: unknown; models?: unknown };
    const rows = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : null;
    if (!rows) throw new Error('GET /models 没有返回模型数组');
    const models: CatalogModel[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string' || !id) continue;
      const window = readWindow(row as Record<string, unknown>);
      this.known.set(id, window);
      const pricing = readPricing(row as Record<string, unknown>);
      if (pricing) this.prices.set(id, pricing);
      models.push(window === undefined ? { id } : { id, contextWindow: window });
    }
    return models.sort((a, b) => compareIds(a.id, b.id));
  }

  /** 最近一次 `list()` 为这个模型记下的窗口;没列到过或目录没给就是 undefined。 */
  contextWindow(model: string): number | undefined {
    return this.known.get(model);
  }

  /** 同上,价目;目录没报价或报价不可计费时是 undefined,由调用方回落到端点自填的价格。 */
  pricing(model: string): CatalogPricing | undefined {
    return this.prices.get(model);
  }

  /** 目录还没取过的时候先取一次;`prices()` 是同步的,靠这个把价目提前备好。 */
  async prime(): Promise<void> {
    if (this.prices.size > 0 || this.known.size > 0) return;
    await this.list().catch(() => undefined);
  }
}
