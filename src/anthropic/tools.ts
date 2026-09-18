/**
 * 工具在 Anthropic Messages 上的形状。与 OpenAI 家族的两处不同:参数表的键叫
 * `input_schema` 而不是 `parameters`,工具结果是 user 轮里的一个内容块而不是独立角色。
 */
import type { Request } from 'cortico/protocol/open-responses/index.ts';

const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** 索引签名在这里是必要的:内容块同时也当通用块传递,而 Anthropic 允许块上带附加字段。 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function toAnthropicTools(tools: Request['tools']): AnthropicTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: {
      $schema: JSON_SCHEMA_DRAFT,
      ...(tool.parameters ?? { type: 'object', properties: {} }),
    },
  }));
}

/**
 * 工具结果块。带图的结果拆成图在前、文本在后的块数组:上游按块顺序读,
 * 文本先到会让随后的图像失去它描述的对象。
 *
 * `images` 收的是已经构造好的 Anthropic 图像块,与历史里的用户图像走同一条构造路径。
 * 标准 Responses 的 `function_call_output` 不带失败标志,所以 `is_error` 目前不会出现。
 */
export function toolResultBlock(
  toolUseId: string,
  output: string,
  images: readonly Record<string, unknown>[] = [],
): ToolResultBlock {
  if (images.length === 0) return { type: 'tool_result', tool_use_id: toolUseId, content: output };
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: [...images, ...(output ? [{ type: 'text', text: output }] : [])],
  };
}
