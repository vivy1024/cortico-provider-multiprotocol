/**
 * 标准 Responses 请求 → Anthropic Messages 请求体。
 *
 * 四条来自 Anthropic 的硬约束决定了这里的形状:
 *  - 顶层 `system` 收的是 `instructions`;历史里的 system 项留在原处,位置才是它们的意义;
 *  - user 与 assistant 必须交替,所以同角色的相邻项要并进一轮;
 *  - 工具结果是 **user** 轮里的 `tool_result` 块,不是独立角色;
 *  - `thinking` 块重放必须带签名,没有签名的推理只能丢掉——发出去会被整轮拒收。
 *
 * 历史按 Core 的上下文记录渲染:`request.input` 里的推理项只剩摘要,签名校验要的是原文;
 * 来源与附件句柄也只在记录上。
 */
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { itemText, type ContextRecord, type ItemOrigin } from 'cortico/protocol/open-responses/context.ts';
import { requestContext } from 'cortico/providers/transport/native-input.ts';
import { REDACTED_THINKING_PREFIX, TOOL_USE_SIGNATURE_PREFIX } from './assembly.ts';
import { toAnthropicTools, toolResultBlock, type AnthropicTool } from './tools.ts';

/** 渲染历史要的本地状态;都由 provider 的 `respond` 选项与宿主给出。 */
export interface HistoryContext {
  /** Core 的上下文记录;缺席时按 `request.input` 渲染,推理一律不重放。 */
  context?: readonly ContextRecord[];
  /** 本次请求的来源;推理只回给产出它的实例、模块、兼容域与模型。 */
  origin?: ItemOrigin;
  keepThinking?: () => boolean;
  media?: { enabled: () => boolean; read: (handle: string) => Buffer | null };
}

export interface AnthropicMessage {
  /** `system` 只在官方接口的对话中段出现;兼容端点那里已经降级成 `user`。 */
  role: 'user' | 'assistant' | 'system';
  content: Array<Record<string, unknown>>;
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: SystemBlock[];
  tools?: AnthropicTool[];
  tool_choice?: Record<string, unknown>;
  temperature?: number;
  thinking?: { type: 'enabled'; budget_tokens: number };
  stream?: boolean;
}

/**
 * 系统提示走块数组而不是单串,为的是能挂 `cache_control`:标记过的前缀由上游缓存,
 * 后续请求命中缓存那部分按缓存价计。低于上游的最小缓存长度时标记无效,但不报错。
 */
const CACHE_MARK = { type: 'ephemeral' } as const;

/** Anthropic 要求 `max_tokens`;请求没给时用这个值,不让上游因为缺字段拒收。 */
const DEFAULT_MAX_TOKENS = 4096;

/** 推理档位换成思考预算。预算必须小于 `max_tokens`,调用方会再夹一次。 */
const EFFORT_BUDGET: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
};

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.refusal === 'string') return record.refusal;
      return '';
    })
    .join('');
}

/** 图像分片转成 Anthropic 的 image 块;认不出的分片跳过,文本引用仍在。 */
function imageBlock(part: Record<string, unknown>): Record<string, unknown> | null {
  const url = part.image_url;
  if (typeof url !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (!match) return { type: 'image', source: { type: 'url', url } };
  return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
}

function userBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Array<Record<string, unknown>> = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const part = raw as Record<string, unknown>;
    if (part.type === 'input_image') {
      const block = imageBlock(part);
      if (block) blocks.push(block);
    } else if (typeof part.text === 'string' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    }
  }
  return blocks;
}

/** 附件句柄指向的图片,端点声明接受图片时才读。 */
function blobImages(entry: ContextRecord, media: HistoryContext['media']): Array<Record<string, unknown>> {
  if (!media?.enabled() || !entry.context.blobs?.length) return [];
  const images: Array<Record<string, unknown>> = [];
  for (const ref of entry.context.blobs) {
    const bytes = media.read(ref.handle);
    if (bytes) images.push({ type: 'image', source: { type: 'base64', media_type: ref.mime, data: bytes.toString('base64') } });
  }
  return images;
}

/**
 * 推理项重放成 thinking 或 redacted_thinking 块。签名在 `encrypted_content`,没有签名不能重放;
 * 签名只有产出它的上游认,来源四项(实例、模块、兼容域、模型)对不上就丢掉。
 */
function thinkingBlock(entry: ContextRecord, history: HistoryContext, model: unknown): Record<string, unknown> | null {
  const item = entry.item;
  if (item.type !== 'reasoning') return null;
  const credential = replayableCredential(entry, history, model);
  if (!credential) return null;
  if (!entry.context.head && history.keepThinking?.() === false) return null;
  if (credential.startsWith(REDACTED_THINKING_PREFIX)) {
    return { type: 'redacted_thinking', data: credential.slice(REDACTED_THINKING_PREFIX.length) };
  }
  return { type: 'thinking', thinking: itemText(item), signature: credential };
}

/** 推理项的凭据,仅当它来自本次请求的实例、模块、兼容域与模型。 */
function replayableCredential(entry: ContextRecord, history: HistoryContext, model: unknown): string | null {
  const item = entry.item;
  if (item.type !== 'reasoning' || typeof item.encrypted_content !== 'string' || !item.encrypted_content) return null;
  const owner = entry.context.origin;
  const current = history.origin;
  if (!owner || !current || owner.instance !== current.instance || owner.module !== current.module
    || owner.compatibilityDomain !== current.compatibilityDomain || owner.model !== model) return null;
  return item.encrypted_content;
}

/** 同角色的相邻轮并成一轮:Anthropic 要求 user 与 assistant 交替。 */
function push(messages: AnthropicMessage[], role: AnthropicMessage['role'], blocks: Array<Record<string, unknown>>): void {
  if (blocks.length === 0) return;
  const last = messages.at(-1);
  if (last?.role === role) last.content.push(...blocks);
  else messages.push({ role, content: blocks });
}

export interface RenderedHistory {
  system: SystemBlock[] | undefined;
  messages: AnthropicMessage[];
}

/**
 * 只有 `instructions` 进顶层 `system`;历史里的 system / developer 项留在原处。
 * 位置是它们的全部意义——提到最前面,模型会把"刚被告知的事"读成背景。
 *
 * 官方接口收对话中段的 `system` 角色,兼容端点不收,那里降级成 `user`:位置保住,
 * 角色让步。
 */
export function renderHistory(request: Request, systemInHistory = false, history: HistoryContext = {}): RenderedHistory {
  const instructions = typeof request.instructions === 'string' ? request.instructions : '';
  const system: SystemBlock[] | undefined = instructions
    ? [{ type: 'text', text: instructions, cache_control: CACHE_MARK }]
    : undefined;
  const midRole = systemInHistory ? ('system' as const) : ('user' as const);
  const messages: AnthropicMessage[] = [];

  // 只存 `tool_use` 签名的推理项紧挨在它的调用前面;签名挂回那个调用,不当思考块发。
  let toolSignature: string | null = null;
  for (const entry of requestContext(request, { context: history.context })) {
    const item = entry.item as unknown as Record<string, unknown>;
    const signature = toolSignature;
    toolSignature = null;
    if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(TOOL_USE_SIGNATURE_PREFIX)) {
      toolSignature = replayableCredential(entry, history, request.model)?.slice(TOOL_USE_SIGNATURE_PREFIX.length) ?? null;
      continue;
    }
    switch (item.type) {
      case 'message': {
        if (item.role === 'system' || item.role === 'developer') {
          const text = textOf(item.content);
          if (text) push(messages, midRole, [{ type: 'text', text }]);
        } else if (item.role === 'assistant') {
          const text = textOf(item.content);
          if (text) push(messages, 'assistant', [{ type: 'text', text }]);
        } else {
          push(messages, 'user', [...userBlocks(item.content), ...blobImages(entry, history.media)]);
        }
        break;
      }
      case 'reasoning': {
        const block = thinkingBlock(entry, history, request.model);
        if (block) push(messages, 'assistant', [block]);
        break;
      }
      case 'function_call': {
        let input_: unknown = {};
        try {
          input_ = item.arguments ? JSON.parse(String(item.arguments)) : {};
        } catch {
          input_ = {};
        }
        push(messages, 'assistant', [{
          type: 'tool_use',
          id: String(item.call_id ?? item.id ?? ''),
          name: String(item.name ?? ''),
          input: input_,
          ...(signature ? { signature } : {}),
        }]);
        break;
      }
      case 'function_call_output': {
        // 工具结果可以是内容数组;图像走与用户图像同一条构造路径,压成纯文本会把它丢掉。
        const blocks = typeof item.output === 'string' ? [] : userBlocks(item.output);
        const images = [...blocks.filter((block) => block.type === 'image'), ...blobImages(entry, history.media)];
        const text = typeof item.output === 'string' ? item.output : textOf(item.output);
        push(messages, 'user', [toolResultBlock(String(item.call_id ?? ''), text, images)]);
        break;
      }
      default:
        break;
    }
  }
  return { system, messages };
}

export function buildAnthropicBody(request: Request, stream: boolean, systemInHistory = false, history: HistoryContext = {}): AnthropicBody {
  const { system, messages } = renderHistory(request, systemInHistory, history);
  const maxTokens = request.max_output_tokens ?? DEFAULT_MAX_TOKENS;
  const body: AnthropicBody = {
    model: String(request.model ?? ''),
    max_tokens: maxTokens,
    messages,
    stream,
  };
  if (system) body.system = system;
  const tools = toAnthropicTools(request.tools);
  if (tools) body.tools = tools;
  if (request.tool_choice === 'required') body.tool_choice = { type: 'any' };
  else if (request.tool_choice === 'none') body.tool_choice = { type: 'none' };
  else if (tools) body.tool_choice = { type: 'auto' };
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  const effort = request.reasoning?.effort;
  const budget = effort ? EFFORT_BUDGET[effort] : undefined;
  // 预算必须严格小于 max_tokens;放不下就不开思考,而不是发一个上游会拒的组合。
  if (budget !== undefined && budget < maxTokens) body.thinking = { type: 'enabled', budget_tokens: budget };
  return body;
}
