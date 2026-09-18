// @vitest-environment jsdom
/** 用框架自己的 ConsoleUi 真实挂载面板,确认它渲染出内容而不是只在 API 层通。 */
import { describe, expect, it } from 'vitest';
import { createConsoleUi } from 'cortico/web/client/ui/index.ts';
import type { ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { gatewayPanel } from '../src/console/gateway-panel.ts';
import type { GatewayState } from '../src/gateway.ts';

function contextFor(state: GatewayState): { ctx: ConsolePanelContext; root: HTMLElement } {
  const doc = document;
  const root = doc.createElement('div');
  doc.body.append(root);
  const ac = new AbortController();
  const ui = createConsoleUi({
    memo: new Map(),
    overlayHost: doc.body,
    doc,
    signal: ac.signal,
  } as never);
  const ctx = {
    ui,
    root,
    doc,
    language: 'zh',
    scope: { instance: 'gw' },
    signal: ac.signal,
    invoke: async () => state,
    interval: () => ({ dispose: () => {} }),
  } as unknown as ConsolePanelContext;
  return { ctx, root };
}

const PROTOCOLS = [
  { value: 'completions-compatible', implemented: true },
  { value: 'responses-compatible', implemented: true },
  { value: 'anthropic-compatible', implemented: false },
];

const HEALTHY: GatewayState = {
  name: 'gw',
  protocol: 'completions-compatible',
  endpointPath: '/chat/completions',
  protocols: PROTOCOLS,
  quota: { supported: true, value: { balance: 9166.82, totalGranted: 9999, unitName: '元' } },
  channels: {
    supported: true,
    value: [
      { channel: 'antigravity', channelType: 'antigravity', healthy: true, availabilityRate: 1 },
      { channel: 'kiro', channelType: 'kiro', healthy: false, availabilityRate: 0 },
    ],
  },
};

describe('gatewayPanel', () => {
  it('renders quota figures and one row per channel', async () => {
    const { ctx, root } = contextFor(HEALTHY);
    await gatewayPanel.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('9166.82');
    expect(text).toContain('9999');
    expect(text).toContain('antigravity');
    expect(text).toContain('kiro');
    expect(text).toContain('100%');
    expect(text).toContain('0%');
  });

  it('states the reason instead of rendering an empty table when the route is absent', async () => {
    const { ctx, root } = contextFor({
      name: 'gw',
      protocol: 'completions-compatible',
      endpointPath: '/chat/completions',
      protocols: PROTOCOLS,
      quota: { supported: false, reason: 'GET /quota 404' },
      channels: { supported: false, reason: 'GET /channels/health 404' },
    });
    await gatewayPanel.mount(ctx);
    const text = root.textContent ?? '';
    expect(text).toContain('GET /quota 404');
    expect(text).toContain('GET /channels/health 404');
  });

  it('offers every protocol and marks the ones without a wire', async () => {
    const { ctx, root } = contextFor(HEALTHY);
    await gatewayPanel.mount(ctx);
    const select = root.querySelector('select');
    expect(select).not.toBeNull();
    const labels = [...select!.options].map((o) => o.textContent);
    expect(labels).toEqual([
      'completions-compatible',
      'responses-compatible',
      'anthropic-compatible(未实现)',
    ]);
    expect(select!.value).toBe('completions-compatible');
  });

  it('asks the server to switch when a protocol is picked', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const { ctx, root } = contextFor(HEALTHY);
    const spy = {
      ...ctx,
      invoke: async (method: string, args: unknown[]) => {
        calls.push([method, args]);
        return HEALTHY;
      },
    } as unknown as ConsolePanelContext;
    await gatewayPanel.mount(spy);
    const select = root.querySelector('select')!;
    select.value = 'responses-compatible';
    select.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.some(([m, a]) =>
      m === 'setProtocol' && (a[0] as { protocol?: string }).protocol === 'responses-compatible')).toBe(true);
  });

  it('surfaces an invoke failure in the message line', async () => {
    const { ctx, root } = contextFor(HEALTHY);
    const failing = { ...ctx, invoke: async () => { throw new Error('boom'); } } as ConsolePanelContext;
    await gatewayPanel.mount(failing);
    expect(root.textContent ?? '').toContain('boom');
  });
});
