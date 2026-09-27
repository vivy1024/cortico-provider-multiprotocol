/**
 * 端点的模型目录。`GET /models` 有两种回应形状:OpenAI 标准的 `data[]` 只列 id;带目录元数据的
 * 端点回 `models[]`,可能附上下文窗口、可用性、建议协议与价格。两种都读,取到什么算什么。
 */
import { protocolForHint, type Protocol } from './protocols.ts';

export interface CatalogModel {
  id: string;
  contextWindow?: number;
}

export interface CatalogEndpoint {
  baseUrl: string;
  headers: Record<string, string>;
}

export interface CatalogPricing {
  currency: string;
  rules: Array<{ meter: string; perMillion: number }>;
  /** 输入达到 `from` 个 token 时整次请求改用这一档。 */
  inputBands?: Array<{ from: number; rules: Array<{ meter: string; perMillion: number }> }>;
}

interface Entry {
  window?: number;
  /** 目录明确标了不可用。 */
  unavailable: boolean;
  protocol?: Protocol;
  pricing?: Record<string, unknown>;
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

/** Code-point 比较:模型 id 是技术标识符,`localeCompare` 会随运行时区域改变顺序。 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 目录的计价字段 → 框架的计量名;括号里是长上下文一档的字段。 */
const METER_BY_FIELD: ReadonlyArray<[field: string, long: string, meter: string]> = [
  ['input', 'longContextInput', 'uncachedInput'],
  ['output', 'longContextOutput', 'output'],
  ['cacheReadInput', 'longContextCacheReadInput', 'cachedInput'],
  ['cacheCreationInput', 'longContextCacheCreationInput', 'detail:cacheCreationInput'],
];

function price(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 目录价格 → 框架价目。只认按 token 计费、`tokenUnit` 个 token 一个单价的写法,倍率乘进单价。
 * 按次或按点数计费的条目不报价:它们的单价不是 token 单价。长上下文一档只认「整次请求换档」。
 */
export function readPricing(raw: Record<string, unknown>, currency: string): CatalogPricing | undefined {
  if (raw.billable === false || raw.pricingConfigured === false) return undefined;
  if (raw.billingMode !== undefined && raw.billingMode !== 'token') return undefined;
  const unit = typeof raw.tokenUnit === 'number' && raw.tokenUnit > 0 ? raw.tokenUnit : 1_000_000;
  const multiplier = typeof raw.multiplier === 'number' && raw.multiplier > 0 ? raw.multiplier : 1;
  const scale = (1_000_000 / unit) * multiplier;
  const rules: CatalogPricing['rules'] = [];
  const longRules: CatalogPricing['rules'] = [];
  for (const [field, long, meter] of METER_BY_FIELD) {
    const base = price(raw[field]);
    if (base === undefined) continue;
    rules.push({ meter, perMillion: base * scale });
    // 长上下文一档里为 0 的字段沿用第一档。
    const second = price(raw[long]);
    longRules.push({ meter, perMillion: (second ? second : base) * scale });
  }
  if (rules.length === 0) return undefined;
  const threshold = typeof raw.longContextThresholdTokens === 'number' ? raw.longContextThresholdTokens : 0;
  if (threshold <= 0) return { currency, rules };
  if (raw.longContextMode !== undefined && raw.longContextMode !== 'full') return undefined;
  return { currency, rules, inputBands: [{ from: threshold, rules: longRules }] };
}

export class ModelCatalog {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly endpoint: () => CatalogEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** 取一次目录。`protocol` 给了就只列建议用这种协议或没给建议的模型;标了不可用的不列。 */
  async list(protocol?: Protocol): Promise<CatalogModel[]> {
    const { baseUrl, headers } = this.endpoint();
    const res = await this.fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: unknown; models?: unknown };
    const rows = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : null;
    if (!rows) throw new Error('GET /models returned no model array');
    this.entries.clear();
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id) continue;
      this.entries.set(row.id, {
        window: readWindow(row),
        unavailable: row.available === false,
        protocol: protocolForHint(row.protocol),
        pricing: row.pricing && typeof row.pricing === 'object' ? row.pricing as Record<string, unknown> : undefined,
      });
    }
    return this.models(protocol);
  }

  private models(protocol?: Protocol): CatalogModel[] {
    const models: CatalogModel[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.unavailable) continue;
      if (protocol && entry.protocol && entry.protocol !== protocol) continue;
      models.push(entry.window === undefined ? { id } : { id, contextWindow: entry.window });
    }
    return models.sort((a, b) => compareIds(a.id, b.id));
  }

  /** 最近一次 `list()` 为这个模型记下的窗口;没列到过或目录没给就是 undefined。 */
  contextWindow(model: string): number | undefined {
    return this.entries.get(model)?.window;
  }

  /** 按给定币种读这个模型的目录价格;目录没报价或报价不是 token 单价时是 undefined。 */
  pricing(model: string, currency: string): CatalogPricing | undefined {
    const raw = this.entries.get(model)?.pricing;
    return raw ? readPricing(raw, currency) : undefined;
  }

  /** 目录还没取过的时候先取一次;`prices()` 是同步的,靠这个把价目提前备好。 */
  async prime(): Promise<void> {
    if (this.entries.size > 0) return;
    await this.list().catch(() => undefined);
  }
}
