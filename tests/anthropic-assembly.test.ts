import { describe, expect, it } from 'vitest';
import type { Request, StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { AnthropicResponseAssembly, anthropicMeters } from '../src/anthropic/assembly.ts';

const REQUEST = { model: 'claude-x' } as Request;

function run(frames: Array<Record<string, unknown>>) {
  const assembly = new AnthropicResponseAssembly(REQUEST);
  const events: StreamEvent[] = [];
  for (const frame of frames) assembly.feed(frame, (e) => events.push(e));
  const response = assembly.finish((e) => events.push(e));
  return { response, events, meters: assembly.meters() };
}

const START = {
  type: 'message_start',
  message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 4 } },
};

describe('AnthropicResponseAssembly', () => {
  it('turns a text block into an assistant message with deltas', () => {
    const { response, events } = run([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
    expect(events[0]!.type).toBe('response.created');
    expect(events.filter((e) => e.type === 'response.output_text.delta')).toHaveLength(2);
    expect(response.status).toBe('completed');
    const item = response.output[0] as { type: string; content: Array<{ text: string }> };
    expect(item.type).toBe('message');
    expect(item.content[0]!.text).toBe('hello');
  });

  it('keeps the thinking signature on the reasoning item so the next turn can replay it', () => {
    const { response } = run([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]);
    const item = response.output[0] as { type: string; encrypted_content?: string; content: Array<{ text: string }> };
    expect(item.type).toBe('reasoning');
    expect(item.encrypted_content).toBe('sig-abc');
    expect(item.content[0]!.text).toBe('weighing');
  });

  it('accumulates tool input json into a function call', () => {
    const { response, events } = run([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'dig' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"dep' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th":3}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    const item = response.output[0] as { type: string; call_id: string; name: string; arguments: string };
    expect(item).toMatchObject({ type: 'function_call', call_id: 'toolu_1', name: 'dig', arguments: '{"depth":3}' });
    expect(events.some((e) => e.type === 'response.function_call_arguments.done')).toBe(true);
  });

  it('carries several blocks into several output items', () => {
    const { response } = run([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'say' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    expect(response.output.map((i) => (i as { type: string }).type)).toEqual(['reasoning', 'message', 'function_call']);
  });

  it('marks the response incomplete when the stop reason is max_tokens', () => {
    const { response } = run([
      START,
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cut' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    ]);
    expect(response.status).toBe('incomplete');
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('throws on a stream error frame instead of finishing quietly', () => {
    const assembly = new AnthropicResponseAssembly(REQUEST);
    expect(() => assembly.feed({ type: 'error', error: { type: 'overloaded_error' } }, () => {}))
      .toThrow(/overloaded_error/);
  });

  it('rejects a delta for a block that never opened', () => {
    const assembly = new AnthropicResponseAssembly(REQUEST);
    assembly.feed(START, () => {});
    expect(() => assembly.feed({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'x' } }, () => {}))
      .toThrow(/unopened/);
  });
});

describe('anthropicMeters', () => {
  it('folds cache reads and writes back into total input', () => {
    const meters = anthropicMeters({
      input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 6, output_tokens: 20,
    });
    expect(meters).toMatchObject({ input: 20, uncachedInput: 10, cachedInput: 4, output: 20, total: 40 });
    expect(meters.details?.cacheCreationInput).toEqual({ quantity: 6, unit: 'token' });
  });

  it('leaves everything unknown when usage is absent', () => {
    expect(anthropicMeters(undefined).input).toBeNull();
    expect(anthropicMeters(undefined).cachedInput).toBeNull();
  });

  it('reads absent cache counters as zero, not unknown, so the cached tier can still be priced', () => {
    const meters = anthropicMeters({ input_tokens: 2, output_tokens: 127 });
    expect(meters).toMatchObject({ input: 2, uncachedInput: 2, cachedInput: 0, output: 127 });
    expect(meters.details?.cacheCreationInput).toEqual({ quantity: 0, unit: 'token' });
  });
});
