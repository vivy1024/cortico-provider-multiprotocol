/**
 * Responses 流的容错层:补上兼容端点漏发的分片开头事件。
 *
 * 规范要求先 `content_part.added`(推理摘要是 `reasoning_summary_part.added`)再发该分片的
 * delta;Core 的累加器照规范严格校验,一条漏了就整轮判协议错误。实测 NUG/antigravity 的
 * Responses 流两种都跳过,直接发 delta,于是这条 wire 一个回答都收不回来。
 *
 * 这里只做一件事:某分片第一次出现 delta / done 而之前没见过它的 added,就在它前面补一条。
 * 补的 part 形状与端点在 `output_item.done` 里给的一致(`{type, text: ''}`),最后的一致性
 * 校验仍然成立。端点规范时这一层除了重新编号什么都不做。
 */
import type { StreamEvent, Response } from 'cortico/protocol/open-responses/index.ts';
import type { TokenMeters } from 'cortico/core/generation.ts';
import { NativeResponseAssembly, type ResponseAssembly } from 'cortico/providers/transport/response-assembly.ts';

type Frame = Record<string, unknown>;

interface PartRule {
  /** 属于这类分片的事件前缀。 */
  prefix: string;
  /** 分片序号的字段名。 */
  indexField: 'content_index' | 'summary_index';
  /** 端点自己会发的那条开头事件;见到它就不补。 */
  opener: string;
  /** 补发时的事件类型与空分片。 */
  synth: { type: string; part: Record<string, unknown> };
}

const RULES: readonly PartRule[] = [
  { prefix: 'response.output_text.', indexField: 'content_index', opener: 'response.content_part.added',
    synth: { type: 'response.content_part.added', part: { type: 'output_text', text: '' } } },
  { prefix: 'response.refusal.', indexField: 'content_index', opener: 'response.content_part.added',
    synth: { type: 'response.content_part.added', part: { type: 'refusal', refusal: '' } } },
  { prefix: 'response.reasoning_summary_text.', indexField: 'summary_index', opener: 'response.reasoning_summary_part.added',
    synth: { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } } },
];

export class TolerantResponseAssembly implements ResponseAssembly {
  private readonly inner = new NativeResponseAssembly();
  /** 已经开过头的分片:`字段/item_id/序号`。 */
  private readonly opened = new Set<string>();
  /**
   * 累加器要求 `sequence_number` 严格递增;补进去的事件插在两个原始序号之间没有整数可用,
   * 所以这一层给所有事件重新编号。原始序号只用于排序校验,下游不读它。
   */
  private sequence = 0;

  private forward(frame: Frame, emit: (event: StreamEvent) => void): void {
    this.inner.feed('sequence_number' in frame ? { ...frame, sequence_number: this.sequence++ } : frame, emit);
  }

  feed(payload: unknown, emit: (event: StreamEvent) => void): void {
    const frame = payload as Frame | null;
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      this.inner.feed(payload, emit);
      return;
    }
    const type = frame.type;
    for (const rule of RULES) {
      const index = frame[rule.indexField];
      if (!Number.isInteger(index)) continue;
      const key = `${rule.indexField}/${String(frame.item_id)}/${String(index)}`;
      if (type === rule.opener) {
        this.opened.add(key);
        break;
      }
      if (!type.startsWith(rule.prefix) || this.opened.has(key)) continue;
      this.opened.add(key);
      this.forward({
        type: rule.synth.type,
        sequence_number: 0,
        output_index: frame.output_index,
        item_id: frame.item_id,
        [rule.indexField]: index,
        part: { ...rule.synth.part },
      }, emit);
      break;
    }
    this.forward(frame, emit);
  }

  finish(): Response { return this.inner.finish(); }
  snapshot(): Response | null { return this.inner.snapshot(); }
  meters(): TokenMeters { return this.inner.meters(); }
  serviceTier(): string | null { return this.inner.serviceTier(); }
}
