/**
 * 端点说哪种方言。协议决定请求体、SSE 装配与模型目录的读法,存在 `entry.options.protocol`;
 * 没写就是 Chat Completions,即这个模块一直以来的行为。
 *
 * 七个选项归到五套 wire:`codex-native` 是 Responses 的变体(多一组固定请求头与 body 约定),
 * `anthropic-official` 是 Anthropic Messages 的变体(对话中段的 system 角色处理不同)。
 */

export const PROTOCOLS = [
  'completions-compatible',
  'responses-compatible',
  'codex-native',
  'anthropic-compatible',
  'anthropic-official',
  'gemini-generate-content',
  'gemini-interactions',
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

/** 未写协议时的取值:保持这个模块原有的 Chat Completions 行为。 */
export const DEFAULT_PROTOCOL: Protocol = 'completions-compatible';

/** 已经有 wire 实现的协议;其余的选中即报错,不静默回落到别的方言。 */
export const IMPLEMENTED: readonly Protocol[] = [
  'completions-compatible',
  'responses-compatible',
  'anthropic-compatible',
  'anthropic-official',
];

export function isAnthropic(protocol: Protocol): boolean {
  return protocol === 'anthropic-compatible' || protocol === 'anthropic-official';
}

export function isProtocol(value: unknown): value is Protocol {
  return typeof value === 'string' && (PROTOCOLS as readonly string[]).includes(value);
}

export function readProtocol(options: Record<string, unknown> | undefined): Protocol {
  const value = options?.protocol;
  return isProtocol(value) ? value : DEFAULT_PROTOCOL;
}

export function defaultPathFor(protocol: Protocol): string {
  if (protocol === 'completions-compatible') return '/chat/completions';
  if (protocol === 'anthropic-compatible') return '/anthropic/messages';
  if (protocol === 'anthropic-official') return '/messages';
  return '/responses';
}

/**
 * 请求路径。Responses 家族收 `options.endpointPath`(控制台那一格),缺省 `/responses`;
 * Chat Completions 固定 `/chat/completions`,那一格对它不生效。
 */
export function endpointPathFor(protocol: Protocol, options: Record<string, unknown> | undefined): string {
  if (protocol === 'completions-compatible') return '/chat/completions';
  const configured = options?.endpointPath;
  if (typeof configured === 'string' && configured.startsWith('/')) {
    if (isAnthropic(protocol) && !configured.includes('messages')) return defaultPathFor(protocol);
    if (!isAnthropic(protocol) && configured.includes('messages')) return defaultPathFor(protocol);
    return configured;
  }
  return defaultPathFor(protocol);
}
