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

export class ChatCompletionsProvider extends OpenAIHttpClient {
  private readonly apiKey?: string;
  private readonly media?: CompatMediaOptions;

  constructor(opts: { baseUrl: string; apiKey?: string; log?: Logger; media?: CompatMediaOptions }) {
    super(opts.baseUrl, opts.log ?? nullLogger());
    this.apiKey = opts.apiKey;
    this.media = opts.media;
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return buildChatRequestBody(spec, messages, tools, this.media);
  }

  protected headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}
