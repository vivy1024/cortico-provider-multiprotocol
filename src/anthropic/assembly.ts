/**
 * Anthropic Messages 流 → 标准 Responses 事件。
 *
 * 一个 Anthropic 内容块对应一个 Responses 输出项,块的 `index` 直接当输出序号用。
 * 三种块各自落到不同的项上:`text` → assistant message,`thinking` → reasoning,
 * `tool_use` → function_call。思考块的签名走 `signature_delta` 单独送达,存进
 * reasoning 项的 `encrypted_content`——下一轮要靠它才能把这段思考放回去。
 */
import { createResponse, type OutputItem, type Request, type Response, type StreamEvent } from 'cortico/protocol/open-responses/index.ts';
import { ResponseAccumulator, ResponseProtocolError } from 'cortico/protocol/open-responses/stream.ts';
import { standardUsage, unknownMeters, type TokenMeters } from 'cortico/core/generation.ts';
import type { ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';

type Item = Record<string, any>;

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Anthropic 把缓存读写单列,`input_tokens` 已经不含它们。总输入要把三者相加,
 * 否则按输入计价的那一档会少算。
 */
export function anthropicMeters(raw: Record<string, any> | null | undefined): TokenMeters {
  if (!raw) return unknownMeters();
  const uncachedInput = number(raw.input_tokens);
  // 报了输入却没报缓存,含义是这一轮没命中缓存,不是"不知道"。留成 null 会让按缓存计价的那一档算不出金额。
  const known = uncachedInput !== null;
  const cacheRead = number(raw.cache_read_input_tokens) ?? (known ? 0 : null);
  const cacheWrite = number(raw.cache_creation_input_tokens) ?? (known ? 0 : null);
  const output = number(raw.output_tokens);
  const input = uncachedInput === null ? null : uncachedInput + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input,
    output,
    total: input !== null && output !== null ? input + output : null,
    cachedInput: cacheRead,
    uncachedInput,
    reasoning: null,
    ...(cacheWrite === null ? {} : { details: { cacheCreationInput: { quantity: cacheWrite, unit: 'token' } } }),
    native: structuredClone(raw),
  };
}

/** `max_tokens` 是唯一会把输出截断的停止原因;其余都算正常收尾。 */
function incompleteReason(stopReason: string | null): string | null {
  return stopReason === 'max_tokens' ? 'max_output_tokens' : null;
}

export class AnthropicResponseAssembly implements ResponseAssembly {
  private readonly response: Response;
  private readonly accumulator = new ResponseAccumulator();
  private sequence = 0;
  private started = false;
  private stopReason: string | null = null;
  private usage: TokenMeters = unknownMeters();
  /** 块序号 → 输出项;Anthropic 的块序号连续,直接当输出序号。 */
  private readonly output: Item[] = [];
  private lastTouched: number | null = null;

  constructor(request: Request) {
    this.response = createResponse(`resp_${crypto.randomUUID()}`, request);
  }

  private send(event: Record<string, unknown>, emit: (event: StreamEvent) => void): void {
    const complete = structuredClone({ ...event, sequence_number: this.sequence++ }) as StreamEvent;
    this.accumulator.accept(complete);
    emit(complete);
  }

  private start(message: Item, emit: (event: StreamEvent) => void): void {
    if (this.started) return;
    if (typeof message?.id === 'string') this.response.id = message.id;
    if (typeof message?.model === 'string') this.response.model = message.model;
    if (message?.usage) this.usage = anthropicMeters(message.usage);
    this.send({ type: 'response.created', response: this.response }, emit);
    this.started = true;
  }

  private openBlock(index: number, block: Item, emit: (event: StreamEvent) => void): void {
    if (this.output[index]) throw new ResponseProtocolError('Anthropic content block indices overlap');
    if (block?.type === 'tool_use') {
      const item: Item = {
        type: 'function_call',
        id: `fc_${crypto.randomUUID()}`,
        call_id: String(block.id ?? `call_${index}`),
        name: String(block.name ?? 'unknown_tool'),
        arguments: '',
        status: 'in_progress',
      };
      this.output[index] = item;
      this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
      return;
    }
    const reasoning = block?.type === 'thinking' || block?.type === 'redacted_thinking';
    const item: Item = reasoning
      ? { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, summary: [], content: [] }
      : { type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'in_progress', content: [] };
    this.output[index] = item;
    this.send({ type: 'response.output_item.added', output_index: index, item }, emit);
    const part = reasoning ? { type: 'reasoning_text', text: '' } : { type: 'output_text', text: '', annotations: [] };
    this.send({ type: 'response.content_part.added', output_index: index, item_id: item.id, content_index: 0, part }, emit);
    item.content = [part];
    // 已经脱敏的思考带不出文本,签名仍要收下,它决定这段能不能放回下一轮。
    if (block?.type === 'redacted_thinking' && typeof block.data === 'string') item.encrypted_content = block.data;
  }

  private delta(index: number, delta: Item, emit: (event: StreamEvent) => void): void {
    const item = this.output[index];
    if (!item) throw new ResponseProtocolError('Anthropic delta for an unopened content block');
    this.lastTouched = index;
    if (delta?.type === 'input_json_delta') {
      const fragment = String(delta.partial_json ?? '');
      if (!fragment) return;
      this.send({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: fragment }, emit);
      item.arguments += fragment;
      return;
    }
    if (delta?.type === 'signature_delta') {
      item.encrypted_content = `${item.encrypted_content ?? ''}${String(delta.signature ?? '')}`;
      return;
    }
    const text = delta?.type === 'thinking_delta' ? delta.thinking : delta?.type === 'text_delta' ? delta.text : undefined;
    if (typeof text !== 'string' || !text) return;
    const reasoning = item.type === 'reasoning';
    this.send({
      type: reasoning ? 'response.reasoning.delta' : 'response.output_text.delta',
      output_index: index, item_id: item.id, content_index: 0, delta: text,
      ...(reasoning ? {} : { logprobs: [] }),
    }, emit);
    item.content[0].text += text;
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const event = payload as Item;
    if (!event || typeof event !== 'object') throw new ResponseProtocolError('Invalid Anthropic stream event');
    switch (event.type) {
      case 'message_start':
        this.start(event.message, emit);
        break;
      case 'content_block_start':
        this.start({}, emit);
        this.openBlock(Number(event.index ?? 0), event.content_block, emit);
        break;
      case 'content_block_delta':
        this.delta(Number(event.index ?? 0), event.delta, emit);
        break;
      case 'message_delta': {
        if (typeof event.delta?.stop_reason === 'string') this.stopReason = event.delta.stop_reason;
        // message_delta 的 usage 只带输出计数,输入侧仍以 message_start 那份为准。
        if (event.usage) {
          const output = number(event.usage.output_tokens);
          if (output !== null) {
            this.usage = { ...this.usage, output, total: this.usage.input !== null ? this.usage.input + output : null };
          }
        }
        break;
      }
      case 'error':
        throw new ResponseProtocolError(`Anthropic stream error: ${JSON.stringify(event.error ?? event)}`);
      case 'content_block_stop':
      case 'message_stop':
      case 'ping':
        break;
      default:
        break;
    }
  }

  finish(emit: (event: StreamEvent) => void): Response {
    const reason = incompleteReason(this.stopReason);
    for (let index = 0; index < this.output.length; index++) {
      const item = this.output[index];
      if (!item) throw new ResponseProtocolError('Anthropic content block indices are not contiguous');
      if (item.type === 'function_call') {
        this.send({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments }, emit);
      } else {
        this.send({ type: 'response.content_part.done', output_index: index, item_id: item.id, content_index: 0, part: item.content[0] }, emit);
      }
      if (item.type !== 'reasoning') item.status = reason && index === this.lastTouched ? 'incomplete' : 'completed';
      this.send({ type: 'response.output_item.done', output_index: index, item }, emit);
    }
    this.response.output = this.output as OutputItem[];
    this.response.usage = standardUsage(this.usage);
    this.response.status = reason ? 'incomplete' : 'completed';
    this.response.completed_at = Math.floor(Date.now() / 1000);
    this.response.incomplete_details = reason ? { reason } : null;
    this.send({ type: `response.${this.response.status}`, response: this.response }, emit);
    return this.accumulator.finish();
  }

  snapshot(): Response | null { return this.accumulator.snapshot(); }
  /** Anthropic 没有服务档这一层。 */
  serviceTier(): string | null { return null; }
  meters(): TokenMeters { return structuredClone(this.usage); }
}
