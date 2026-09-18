/**
 * 一个端点的网关状态:通道健康与配额。端点名来自 `ctx.scope.instance`。
 * 两块信息各自独立地可能"不支持",一块缺席不影响另一块显示。
 */
import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import type { GatewayState } from '../gateway.ts';
import { panel } from './strings.ts';

const POLL_MS = 15_000;

/** 可用率配色:满格算好,半格中性,再低视同故障。 */
function tone(rate: number): 'on' | 'off' | 'plain' {
  if (rate >= 0.8) return 'on';
  if (rate >= 0.5) return 'plain';
  return 'off';
}

export const gatewayPanel: ConsolePanel = {
  mount: async (ctx: ConsolePanelContext) => {
    const { ui, root } = ctx;
    const S = ctx.language === 'en' ? panel.en : panel.zh;
    const name = ctx.scope.instance;
    const card = ui.sheet({ title: S.title });
    const message = ui.msgline();
    root.append(card.el, message);
    let lastSnapshot = '';

    function renderQuota(state: GatewayState, body: HTMLElement): void {
      if (!state.quota.supported) {
        body.append(ui.placeholder(S.unsupported(state.quota.reason)));
        return;
      }
      const q = state.quota.value;
      const unit = q.unitName ? ` ${q.unitName}` : '';
      const rows = [];
      if (q.balance !== undefined) rows.push({ k: S.balance, v: `${q.balance.toFixed(2)}${unit}` });
      if (q.totalAvailable !== undefined) rows.push({ k: S.available, v: `${q.totalAvailable.toFixed(2)}${unit}` });
      if (q.totalGranted !== undefined) rows.push({ k: S.granted, v: `${q.totalGranted.toFixed(2)}${unit}` });
      body.append(rows.length ? ui.kv(rows) : ui.placeholder(S.unsupported('empty')));
    }

    function renderChannels(state: GatewayState, body: HTMLElement): void {
      if (!state.channels.supported) {
        body.append(ui.placeholder(S.unsupported(state.channels.reason)));
        return;
      }
      const channels = state.channels.value;
      const table = ui.table({ head: [S.channel, S.kind, S.availability, S.credentials, S.concurrency] });
      if (channels.length === 0) table.clear(S.noChannels);
      for (const ch of channels) {
        const percent = Math.round(ch.availabilityRate * 100);
        const state_ = ui.h('div');
        state_.append(ui.pill(`${percent}%`, tone(ch.availabilityRate)));
        if (ch.healthy === false) state_.append(ui.pill(S.down, 'off'));
        else if (ch.healthy === true) state_.append(ui.pill(S.healthy, 'on'));
        const credentials = ch.availableCredentials !== undefined && ch.totalCredentials !== undefined
          ? `${ch.availableCredentials}/${ch.totalCredentials}` : '';
        const concurrency = ch.currentConcurrency !== undefined && ch.maxConcurrency !== undefined
          ? `${ch.currentConcurrency}/${ch.maxConcurrency}` : '';
        table.addRow([
          { text: ch.channel ?? ch.channelType, cls: 'mono' },
          { text: ch.channelType, cls: 'mono' },
          state_,
          credentials,
          concurrency,
        ]);
      }
      body.append(table.el);
    }

    function render(state: GatewayState, body: HTMLElement): void {
      const bar = ui.rowbar();
      bar.append(ui.button(S.refresh, { size: 'sm', onClick: () => void load(true) }));
      body.append(bar);
      body.append(ui.section(S.wire));
      const select = ui.select({
        value: state.protocol,
        options: state.protocols.map((p) => ({
          value: p.value,
          label: p.implemented ? p.value : S.notImplemented(p.value),
        })),
        onChange: (value) => void switchProtocol(value),
      });
      select.setAttribute('aria-label', S.protocol);
      body.append(ui.field(S.protocol, select));
      body.append(ui.kv([{ k: S.requestPath, v: state.endpointPath }]));
      body.append(ui.section(S.quota));
      renderQuota(state, body);
      body.append(ui.section(S.channels));
      renderChannels(state, body);
    }

    /** 换方言要重取:新 wire 的请求路径不同,面板显示的必须是保存之后的实际值。 */
    async function switchProtocol(protocol: string): Promise<void> {
      message.textContent = '';
      try {
        await ctx.invoke('setProtocol', [{ name, protocol }]);
      } catch (error) {
        message.textContent = String(error);
      }
      await load(true);
    }

    async function load(force = false): Promise<void> {
      let state: GatewayState;
      try {
        state = await ctx.invoke<GatewayState>('state', [{ name }]);
      } catch (error) {
        message.textContent = String(error);
        return;
      }
      if (ctx.signal.aborted) return;
      message.textContent = '';
      const snapshot = JSON.stringify(state);
      if (!force && snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      card.body.replaceChildren();
      render(state, card.body);
    }

    await load(true);
    ctx.interval(() => void load(), POLL_MS);
  },
};
