import { describe, expect, it } from 'vitest';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { buildAnthropicBody, renderHistory } from '../src/anthropic/body.ts';
import { toAnthropicTools, toolResultBlock } from '../src/anthropic/tools.ts';

function req(partial: Partial<Request>): Request {
  return { model: 'claude-x', ...partial } as Request;
}

describe('renderHistory', () => {
  it('puts instructions in the top-level system field and marks it cacheable', () => {
    const { system } = renderHistory(req({ instructions: 'be brief', input: [] as never }));
    expect(system).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }]);
  });

  it('omits the system field entirely when there are no instructions', () => {
    expect(renderHistory(req({ input: 'hi' })).system).toBeUndefined();
  });

  it('keeps a mid-conversation system item in place rather than hoisting it', () => {
    const { system, messages } = renderHistory(req({
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'message', role: 'system', content: 'it is now night' },
        { type: 'message', role: 'user', content: 'what now' },
      ] as never,
    }));
    // 顶层只拿 instructions;那条 sys 仍排在两轮用户之间。
    expect(system).toEqual([{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content.map((b) => b.text)).toEqual(['hi', 'it is now night', 'what now']);
  });

  it('downgrades a mid-conversation system item to user on compatible endpoints', () => {
    const { messages } = renderHistory(req({
      input: [
        { type: 'message', role: 'assistant', content: 'ok' },
        { type: 'message', role: 'system', content: 'context' },
      ] as never,
    }));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
  });

  it('keeps the system role on the official API', () => {
    const { messages } = renderHistory(req({
      input: [
        { type: 'message', role: 'assistant', content: 'ok' },
        { type: 'message', role: 'system', content: 'context' },
      ] as never,
    }), true);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'system']);
  });

  it('merges adjacent same-role items so the roles stay alternating', () => {
    const { messages } = renderHistory(req({
      input: [
        { type: 'message', role: 'user', content: 'one' },
        { type: 'message', role: 'user', content: 'two' },
        { type: 'message', role: 'assistant', content: 'ack' },
      ] as never,
    }));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] });
  });

  it('puts a tool call on the assistant turn and its result on the following user turn', () => {
    const { messages } = renderHistory(req({
      input: [
        { type: 'message', role: 'user', content: 'dig' },
        { type: 'function_call', call_id: 'c1', name: 'dig', arguments: '{"depth":3}' },
        { type: 'function_call_output', call_id: 'c1', output: 'done' },
      ] as never,
    }));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'dig', input: { depth: 3 } });
    expect(messages[2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'done' });
  });

  it('keeps a tool call usable when its arguments are not valid JSON', () => {
    const { messages } = renderHistory(req({
      input: [{ type: 'function_call', call_id: 'c1', name: 'dig', arguments: '{oops' }] as never,
    }));
    expect(messages[0]!.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('carries an image out of a tool result instead of flattening it to text', () => {
    const { messages } = renderHistory(req({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' },
        {
          type: 'function_call_output', call_id: 'c1',
          output: [
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_text', text: 'screenshot taken' },
          ],
        },
      ] as never,
    }));
    const result = messages[1]!.content[0] as { type: string; content: Array<Record<string, unknown>> };
    expect(result.type).toBe('tool_result');
    expect(result.content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(result.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  });

  it('replays reasoning only when a signature came with it', () => {
    const withSignature = renderHistory(req({
      input: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'pondering' }], encrypted_content: 'sig-1' }] as never,
    }));
    expect(withSignature.messages[0]!.content[0]).toEqual({ type: 'thinking', thinking: 'pondering', signature: 'sig-1' });

    const withoutSignature = renderHistory(req({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'pondering' }] },
        { type: 'message', role: 'assistant', content: 'done' },
      ] as never,
    }));
    expect(withoutSignature.messages[0]!.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('turns a data-url image into a base64 source and keeps remote urls as urls', () => {
    const { messages } = renderHistory(req({
      input: [{
        type: 'message', role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
          { type: 'input_image', image_url: 'https://example.com/a.png' },
          { type: 'input_text', text: 'look' },
        ],
      }] as never,
    }));
    expect(messages[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'text', text: 'look' },
    ]);
  });
});

describe('buildAnthropicBody', () => {
  it('always sends max_tokens because Anthropic requires it', () => {
    expect(buildAnthropicBody(req({ input: 'hi' }), false).max_tokens).toBe(4096);
    expect(buildAnthropicBody(req({ input: 'hi', max_output_tokens: 128 }), false).max_tokens).toBe(128);
  });

  it('enables thinking only when the budget fits inside max_tokens', () => {
    const roomy = buildAnthropicBody(req({ input: 'hi', max_output_tokens: 8000, reasoning: { effort: 'low' } }), false);
    expect(roomy.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });

    const cramped = buildAnthropicBody(req({ input: 'hi', max_output_tokens: 512, reasoning: { effort: 'high' } }), false);
    expect(cramped.thinking).toBeUndefined();

    const off = buildAnthropicBody(req({ input: 'hi', reasoning: { effort: 'none' } }), false);
    expect(off.thinking).toBeUndefined();
  });

  it('maps tool choice and carries the stream flag', () => {
    const tools = [{ type: 'function', name: 'dig', description: 'dig', parameters: { type: 'object' } }] as never;
    expect(buildAnthropicBody(req({ input: 'hi', tools, tool_choice: 'required' }), true))
      .toMatchObject({ tool_choice: { type: 'any' }, stream: true });
    expect(buildAnthropicBody(req({ input: 'hi', tools }), false).tool_choice).toEqual({ type: 'auto' });
    expect(buildAnthropicBody(req({ input: 'hi' }), false).tool_choice).toBeUndefined();
  });
});

describe('tools', () => {
  it('renames parameters to input_schema and stamps the draft', () => {
    const [tool] = toAnthropicTools([{ type: 'function', name: 'dig', description: 'd', parameters: { type: 'object' } }] as never)!;
    expect(tool).toEqual({
      name: 'dig', description: 'd',
      input_schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    });
  });

  it('keeps a plain text result plain', () => {
    expect(toolResultBlock('c1', 'ok')).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'ok' });
  });

  it('puts images before the text so each image still has its caption after it', () => {
    const block = toolResultBlock('c1', 'ok', [{ type: 'image', source: { type: 'base64' } }]);
    expect((block.content as Array<Record<string, unknown>>).map((b) => b.type)).toEqual(['image', 'text']);
  });
});
