/**
 * Anthropic Messages 方言的客户端。`OpenAIHttpClient` 带着 HTTP / SSE 引擎、重试、计量与
 * 失败判定;方言只负责请求体、请求头与流的装配。
 */
import type { Logger } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { createResponse, type OutputItem, type Request } from 'cortico/protocol/open-responses/index.ts';
import { ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import { standardUsage, type GenerateOptions } from 'cortico/core/generation.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import type { ResponseAssembly, parseChatResponse } from 'cortico/providers/transport/response-assembly.ts';
import { AnthropicResponseAssembly, anthropicMeters } from './assembly.ts';
import { buildAnthropicBody } from './body.ts';

/** Messages API 的版本头。上游按它决定响应形状,缺了会被拒。 */
const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey?: string;
  /** 相对 baseUrl 的路径;默认 `/messages`,经网关时通常要写成网关挂载 Anthropic 的那一段。 */
  endpointPath?: string;
  /** 官方接口收对话中段的 `system` 角色,兼容端点不收。 */
  official?: boolean;
  extraHeaders?: Record<string, string>;
  log?: Logger;
}

/** 非流式响应的内容块 → 标准输出项。与装配器同一套映射,只是没有中间事件。 */
function outputFrom(content: unknown): OutputItem[] {
  const items: OutputItem[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, any>;
    if (block.type === 'text') {
      items.push({
        type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: String(block.text ?? ''), annotations: [] }],
      } as unknown as OutputItem);
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      items.push({
        type: 'reasoning', id: `rs_${crypto.randomUUID()}`,
        summary: [{ type: 'summary_text', text: String(block.thinking ?? '') }],
        content: [{ type: 'reasoning_text', text: String(block.thinking ?? '') }],
        ...(typeof block.signature === 'string' ? { encrypted_content: block.signature }
          : typeof block.data === 'string' ? { encrypted_content: block.data } : {}),
      } as unknown as OutputItem);
    } else if (block.type === 'tool_use') {
      items.push({
        type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: String(block.id ?? ''),
        name: String(block.name ?? 'unknown_tool'), arguments: JSON.stringify(block.input ?? {}), status: 'completed',
      } as unknown as OutputItem);
    }
  }
  return items;
}

export class AnthropicProvider extends OpenAIHttpClient {
  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.opts = opts;
    this.chatPath = opts.endpointPath ?? '/messages';
  }

  protected override buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    return buildAnthropicBody(request, Boolean(options.onEvent), this.opts.official === true) as unknown as Record<string, unknown>;
  }

  /** Chat 的请求体构造在这条方言上不可达:`buildResponseBody` 已整个覆写。 */
  protected buildBody(): never {
    throw new Error('AnthropicProvider does not build Chat Completions bodies');
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...this.opts.extraHeaders,
    };
    // 官方接口认 `x-api-key`,网关多按 Bearer 转发;两个都带,认哪个由上游决定。
    if (this.opts.apiKey) {
      headers['x-api-key'] = this.opts.apiKey;
      headers.Authorization = `Bearer ${this.opts.apiKey}`;
    }
    return headers;
  }

  protected override responseAssembly(request: Request): ResponseAssembly {
    return new AnthropicResponseAssembly(request);
  }

  protected override parseResponse(raw: unknown, request: Request): ReturnType<typeof parseChatResponse> {
    const data = raw as Record<string, any>;
    if (!data || data.type !== 'message' || !Array.isArray(data.content)) {
      throw new ResponseProtocolError('Invalid Anthropic message resource');
    }
    const meters = anthropicMeters(data.usage);
    const incomplete = data.stop_reason === 'max_tokens';
    return {
      response: {
        ...createResponse(String(data.id ?? `resp_${crypto.randomUUID()}`), request),
        model: String(data.model ?? request.model ?? ''),
        output: outputFrom(data.content),
        status: incomplete ? 'incomplete' : 'completed',
        incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
        completed_at: Math.floor(Date.now() / 1000),
        usage: standardUsage(meters),
      },
      meters,
      serviceTier: null,
    };
  }
}
