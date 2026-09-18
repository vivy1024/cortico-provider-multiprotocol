/**
 * 标准 Responses 请求 → Anthropic Messages 请求体。
 *
 * 四条来自 Anthropic 的硬约束决定了这里的形状:
 *  - 顶层 `system` 收的是 `instructions`;历史里的 system 项留在原处,位置才是它们的意义;
 *  - user 与 assistant 必须交替,所以同角色的相邻项要并进一轮;
 *  - 工具结果是 **user** 轮里的 `tool_result` 块,不是独立角色;
 *  - `thinking` 块重放必须带签名,没有签名的推理只能丢掉——发出去会被整轮拒收。
 */
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { toAnthropicTools, toolResultBlock, type AnthropicTool } from './tools.ts';

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

/** 推理项重放成 thinking 块。签名在 `encrypted_content`;没有签名就不能重放。 */
function thinkingBlock(item: Record<string, unknown>): Record<string, unknown> | null {
  const signature = item.encrypted_content;
  if (typeof signature !== 'string' || !signature) return null;
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const thinking = summary
    .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('');
  return { type: 'thinking', thinking, signature };
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
export function renderHistory(request: Request, official = false): RenderedHistory {
  const instructions = typeof request.instructions === 'string' ? request.instructions : '';
  const system: SystemBlock[] | undefined = instructions
    ? [{ type: 'text', text: instructions, cache_control: CACHE_MARK }]
    : undefined;
  const midRole = official ? ('system' as const) : ('user' as const);
  const messages: AnthropicMessage[] = [];
  const input = request.input;

  if (typeof input === 'string') {
    push(messages, 'user', [{ type: 'text', text: input }]);
    return { system, messages };
  }

  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    switch (item.type) {
      case 'message': {
        if (item.role === 'system' || item.role === 'developer') {
          const text = textOf(item.content);
          if (text) push(messages, midRole, [{ type: 'text', text }]);
        } else if (item.role === 'assistant') {
          const text = textOf(item.content);
          if (text) push(messages, 'assistant', [{ type: 'text', text }]);
        } else {
          push(messages, 'user', userBlocks(item.content));
        }
        break;
      }
      case 'reasoning': {
        const block = thinkingBlock(item);
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
        }]);
        break;
      }
      case 'function_call_output': {
        // 工具结果可以是内容数组;图像走与用户图像同一条构造路径,压成纯文本会把它丢掉。
        const blocks = typeof item.output === 'string' ? [] : userBlocks(item.output);
        const images = blocks.filter((block) => block.type === 'image');
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

export function buildAnthropicBody(request: Request, stream: boolean, official = false): AnthropicBody {
  const { system, messages } = renderHistory(request, official);
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
