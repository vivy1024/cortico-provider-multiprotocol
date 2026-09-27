import type { Logger, ModelSpec, ToolSchema } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';
import { OpenAIHttpClient } from 'cortico/providers/transport/chat.ts';
import { mapTools, renderMessagesWithMedia, type CompatMediaOptions } from 'cortico/providers/transport/history.ts';
import type { NativeChatMessage } from 'cortico/providers/transport/native-types.ts';

export function buildChatRequestBody(
  spec: ModelSpec,
  messages: NativeChatMessage[],
  tools?: ToolSchema[],
  media?: CompatMediaOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: renderMessagesWithMedia(messages, media),
  };
  if (spec.thinking && spec.reasoningEffort) body.reasoning_effort = spec.reasoningEffort;
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
  const mapped = mapTools(tools);
  if (mapped && mapped.length > 0) {
    body.tools = mapped;
    body.tool_choice = 'auto';
  }
  return body;
}

export interface ChatCompletionsOptions {
  baseUrl: string;
  apiKey?: string;
  /** 相对 baseUrl 的路径;默认 `/chat/completions`。 */
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  /** 最后并入请求体,能覆盖上面构造的同名字段。 */
  extraBody?: Record<string, unknown>;
  log?: Logger;
  media?: CompatMediaOptions;
}

export class ChatCompletionsProvider extends OpenAIHttpClient {
  private readonly opts: ChatCompletionsOptions;

  constructor(opts: ChatCompletionsOptions) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.opts = opts;
    if (opts.endpointPath) this.chatPath = opts.endpointPath;
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return { ...buildChatRequestBody(spec, messages, tools, this.opts.media), ...this.opts.extraBody };
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.opts.extraHeaders,
      ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }
}
