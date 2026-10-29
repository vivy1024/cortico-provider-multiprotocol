import { describe, expect, it } from 'vitest';
import type { StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { TolerantResponseAssembly } from '../src/responses-assembly.ts';

const created = { type: 'response.created', sequence_number: 0, response: { id: 'r1', model: 'm', status: 'in_progress', output: [] } };
const msg = (status: string, content: unknown[]) => ({ type: 'message', id: 'msg_1', role: 'assistant', status, content });

function run(frames: Array<Record<string, unknown>>) {
  const a = new TolerantResponseAssembly();
  const events: StreamEvent[] = [];
  for (const f of frames) a.feed(f, (e) => events.push(e));
  return { response: a.finish(), events, meters: a.meters() };
}

describe('TolerantResponseAssembly', () => {
  // 实测 NUG/antigravity 的 Responses 流:没有 content_part.added,直接 delta。
  it('synthesizes the missing content_part.added before the first text delta', () => {
    const { response, events } = run([
      created,
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: msg('in_progress', []) },
      { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'OK' },
      { type: 'response.output_text.done', sequence_number: 3, output_index: 0, item_id: 'msg_1', content_index: 0, text: 'OK' },
      { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: msg('completed', [{ type: 'output_text', text: 'OK' }]) },
      { type: 'response.completed', sequence_number: 5, response: { id: 'r1', model: 'm', status: 'completed',
        output: [msg('completed', [{ type: 'output_text', text: 'OK' }])],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 105 } } },
    ]);
    expect(events.filter((e) => e.type === 'response.content_part.added')).toHaveLength(1);
    expect(response.status).toBe('completed');
    expect((response.output[0] as { content: Array<{ text: string }> }).content[0]!.text).toBe('OK');
  });

  it('reads cached tokens from the completed usage', () => {
    const { meters } = run([
      created,
      { type: 'response.completed', sequence_number: 1, response: { id: 'r1', model: 'm', status: 'completed', output: [],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5, total_tokens: 105 } } },
    ]);
    expect(meters).toMatchObject({ input: 100, cachedInput: 80, uncachedInput: 20, output: 5 });
  });

  it('adds nothing when the endpoint sends content_part.added itself', () => {
    const part = { type: 'output_text', text: '', annotations: [] };
    const { events } = run([
      created,
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: msg('in_progress', []) },
      { type: 'response.content_part.added', sequence_number: 2, output_index: 0, item_id: 'msg_1', content_index: 0, part },
      { type: 'response.output_text.delta', sequence_number: 3, output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'hi' },
      { type: 'response.output_text.done', sequence_number: 4, output_index: 0, item_id: 'msg_1', content_index: 0, text: 'hi' },
      { type: 'response.content_part.done', sequence_number: 5, output_index: 0, item_id: 'msg_1', content_index: 0,
        part: { type: 'output_text', text: 'hi', annotations: [] } },
      { type: 'response.output_item.done', sequence_number: 6, output_index: 0,
        item: msg('completed', [{ type: 'output_text', text: 'hi', annotations: [] }]) },
      { type: 'response.completed', sequence_number: 7, response: { id: 'r1', model: 'm', status: 'completed',
        output: [msg('completed', [{ type: 'output_text', text: 'hi', annotations: [] }])] } },
    ]);
    expect(events.filter((e) => e.type === 'response.content_part.added')).toHaveLength(1);
  });
  it('synthesizes the missing reasoning_summary_part.added before a summary delta', () => {
    const rs = (status: string, summary: unknown[]) => ({ type: 'reasoning', id: 'rs_1', status, summary });
    const { response, events } = run([
      created,
      { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: rs('in_progress', []) },
      { type: 'response.reasoning_summary_text.delta', sequence_number: 2, output_index: 0, item_id: 'rs_1', summary_index: 0, delta: '想' },
      { type: 'response.reasoning_summary_text.done', sequence_number: 3, output_index: 0, item_id: 'rs_1', summary_index: 0, text: '想' },
      { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: rs('completed', [{ type: 'summary_text', text: '想' }]) },
      { type: 'response.completed', sequence_number: 5, response: { id: 'r1', model: 'm', status: 'completed',
        output: [rs('completed', [{ type: 'summary_text', text: '想' }])] } },
    ]);
    expect(events.filter((e) => e.type === 'response.reasoning_summary_part.added')).toHaveLength(1);
    expect(response.status).toBe('completed');
  });
});

