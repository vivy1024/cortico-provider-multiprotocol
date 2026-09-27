import { describe, expect, it } from 'vitest';
import type { Request } from 'cortico/protocol/open-responses/index.ts';
import { inputItem, record, responseRecords, type ContextRecord, type ItemOrigin } from 'cortico/protocol/open-responses/context.ts';
import { buildAnthropicBody, renderHistory, type HistoryContext } from '../src/anthropic/body.ts';
import { AnthropicResponseAssembly } from '../src/anthropic/assembly.ts';
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

  describe('reasoning replay', () => {
    const ORIGIN: ItemOrigin = { instance: 'ep', module: 'multiprotocol', model: 'claude-x', compatibilityDomain: 'd1' };

    /** One streamed turn through the package's assembly, stored the way Core stores it. */
    function storedTurn(blocks: Array<{ frames: Array<Record<string, unknown>> }>): ContextRecord[] {
      const assembly = new AnthropicResponseAssembly(req({}));
      const frames: Array<Record<string, unknown>> = [{ type: 'message_start', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 1 } } }];
      for (const block of blocks) frames.push(...block.frames);
      frames.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' });
      for (const frame of frames) assembly.feed(frame, () => {});
      return responseRecords(assembly.finish(() => {}), ORIGIN);
    }
    const thinking = (index: number, text: string, signature: string) => ({ frames: [
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index },
    ] });
    const redacted = (index: number, data: string) => ({ frames: [
      { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data } },
      { type: 'content_block_stop', index },
    ] });
    const replay = (records: ContextRecord[], history: Partial<HistoryContext> = {}) => renderHistory(
      req({ input: records.map(inputItem) as never }), false, { context: records, origin: ORIGIN, ...history });

    it('replays a streamed thinking block with its text and signature', () => {
      const { messages } = replay(storedTurn([thinking(0, 'pondering', 'sig-1')]));
      expect(messages[0]!.content[0]).toEqual({ type: 'thinking', thinking: 'pondering', signature: 'sig-1' });
    });

    it('replays a redacted block as redacted_thinking with its data', () => {
      const { messages } = replay(storedTurn([redacted(0, 'opaque')]));
      expect(messages[0]!.content[0]).toEqual({ type: 'redacted_thinking', data: 'opaque' });
    });

    it('drops reasoning from another endpoint, another model or without a signature', () => {
      const records = storedTurn([thinking(0, 'pondering', 'sig-1')]);
      expect(replay(records, { origin: { ...ORIGIN, compatibilityDomain: 'd2' } }).messages).toEqual([]);
      expect(renderHistory(req({ model: 'claude-y', input: records.map(inputItem) as never }), false, { context: records, origin: ORIGIN }).messages).toEqual([]);
      const unsigned = [record({ type: 'reasoning', id: 'rs_1', summary: [], content: [{ type: 'reasoning_text', text: 'x' }] } as never, { origin: ORIGIN })];
      expect(replay(unsigned).messages).toEqual([]);
    });

    it('drops past reasoning when keepThinking is off and replays none without context records', () => {
      const records = storedTurn([thinking(0, 'pondering', 'sig-1')]);
      expect(replay(records, { keepThinking: () => false }).messages).toEqual([]);
      expect(renderHistory(req({ input: records.map(inputItem) as never })).messages).toEqual([]);
    });
  });

  it('attaches blob images to user messages and tool results when media is enabled', () => {
    const blobs = [{ handle: 'h1', mime: 'image/png' }] as never;
    const records = [
      record({ type: 'message', role: 'user', content: 'look' } as never, { blobs }),
      record({ type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' } as never),
      record({ type: 'function_call_output', call_id: 'c1', output: 'captured' } as never, { blobs }),
    ];
    const media = { enabled: () => true, read: (handle: string) => (handle === 'h1' ? Buffer.from([1, 2, 3]) : null) };
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } };
    const { messages } = renderHistory(req({ input: records.map(inputItem) as never }), false, { context: records, media });
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'look' }, image]);
    const result = messages[2]!.content[0] as { content: unknown[] };
    expect(result.content).toEqual([image, { type: 'text', text: 'captured' }]);
    const off = renderHistory(req({ input: records.map(inputItem) as never }), false, { context: records, media: { ...media, enabled: () => false } });
    expect(off.messages[0]!.content).toEqual([{ type: 'text', text: 'look' }]);
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
