/**
 * 端点说哪种协议。协议决定请求体、SSE 装配与默认请求路径,存在 `entry.options.protocol`;
 * 没写就是 OpenAI Chat Completions。
 */

export const PROTOCOLS = [
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const DEFAULT_PROTOCOL: Protocol = 'openai-chat-completions';

/**
 * 0.1 的取值。`anthropic-official` 与 `anthropic-compatible` 只差对话中段 system 的处理,
 * 现在是 `anthropic-messages` 加 `systemInHistory`。
 */
const LEGACY: Readonly<Record<string, { protocol: Protocol; systemInHistory?: true }>> = {
  'completions-compatible': { protocol: 'openai-chat-completions' },
  'responses-compatible': { protocol: 'openai-responses' },
  'anthropic-compatible': { protocol: 'anthropic-messages' },
  'anthropic-official': { protocol: 'anthropic-messages', systemInHistory: true },
};

export function isProtocol(value: unknown): value is Protocol {
  return typeof value === 'string' && (PROTOCOLS as readonly string[]).includes(value);
}

/** 当前取值或 0.1 的取值都认;其余值由 `validateEntry` 拒绝。 */
export function isKnownProtocol(value: unknown): boolean {
  return isProtocol(value) || (typeof value === 'string' && value in LEGACY);
}

export function readProtocol(options: Record<string, unknown> | undefined): Protocol {
  const value = options?.protocol;
  if (isProtocol(value)) return value;
  if (typeof value === 'string' && value in LEGACY) return LEGACY[value].protocol;
  return DEFAULT_PROTOCOL;
}

/** 0.1 的协议取值换成当前的;没有旧取值时原样返回。 */
export function migrateOptions(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = options?.protocol;
  if (typeof value !== 'string' || !(value in LEGACY)) return options;
  const legacy = LEGACY[value];
  return { ...options, protocol: legacy.protocol, ...(legacy.systemInHistory ? { systemInHistory: true } : {}) };
}

export function defaultPathFor(protocol: Protocol): string {
  if (protocol === 'openai-chat-completions') return '/chat/completions';
  if (protocol === 'anthropic-messages') return '/messages';
  return '/responses';
}

/** 请求路径:`options.endpointPath` 以 `/` 开头就用它,否则用协议的默认路径。 */
export function endpointPathFor(protocol: Protocol, options: Record<string, unknown> | undefined): string {
  const configured = options?.endpointPath;
  return typeof configured === 'string' && configured.startsWith('/') ? configured : defaultPathFor(protocol);
}

/**
 * 模型目录里「建议客户端用的协议」对应到这里的哪一种。目录用什么词由端点决定,
 * 这里只认几个通用写法;认不出的当作没给建议。
 */
export function protocolForHint(hint: unknown): Protocol | undefined {
  if (typeof hint !== 'string') return undefined;
  const value = hint.toLowerCase();
  if (value === 'anthropic' || value === 'messages') return 'anthropic-messages';
  if (value === 'responses' || value === 'codex') return 'openai-responses';
  if (value === 'openai' || value === 'chat' || value === 'chat-completions') return 'openai-chat-completions';
  return undefined;
}
