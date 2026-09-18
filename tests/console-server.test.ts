import { describe, expect, it, vi } from 'vitest';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import { gatewayConsole } from '../src/console/server.ts';
import { Gateway } from '../src/gateway.ts';

function hostWith(entry: LLMProviderEntry) {
  const save = vi.fn();
  const gateway = new Gateway(
    () => ({ baseUrl: 'https://gateway.example/v1', headers: {} }),
    (async () => new Response('nope', { status: 404 })) as typeof fetch,
  );
  const host = {
    language: 'zh' as const,
    entries: () => [{ name: 'gw', entry }],
    instance: () => ({ control: { gateway, protocol: 'completions-compatible', endpointPath: '/chat/completions' } }),
    save,
  };
  return { host, save };
}

const ENTRY: LLMProviderEntry = {
  kind: 'multiprotocol',
  baseUrl: 'https://gateway.example/v1',
  options: { endpointPath: '/responses', extraHeaders: { 'X-Trace': '1' } },
};

describe('setProtocol', () => {
  it('keeps the other options intact when writing the protocol', async () => {
    const { host, save } = hostWith(ENTRY);
    const contribution = gatewayConsole(host as never);
    await contribution.invoke!('gateway', 'setProtocol', [{ name: 'gw', protocol: 'responses-compatible' }]);
    expect(save).toHaveBeenCalledTimes(1);
    const [name, next] = save.mock.calls[0]!;
    expect(name).toBe('gw');
    expect(next.options).toEqual({
      endpointPath: '/responses',
      extraHeaders: { 'X-Trace': '1' },
      protocol: 'responses-compatible',
    });
  });

  it('refuses an unknown protocol and writes nothing', async () => {
    const { host, save } = hostWith(ENTRY);
    const contribution = gatewayConsole(host as never);
    await expect(
      contribution.invoke!('gateway', 'setProtocol', [{ name: 'gw', protocol: 'grpc' }]),
    ).rejects.toThrow(/grpc/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('state', () => {
  it('lists every protocol and marks which ones have a wire', async () => {
    const { host } = hostWith(ENTRY);
    const contribution = gatewayConsole(host as never);
    const state = (await contribution.invoke!('gateway', 'state', [{ name: 'gw' }])) as {
      protocols: { value: string; implemented: boolean }[];
      protocol: string;
    };
    expect(state.protocols).toHaveLength(7);
    expect(state.protocols.filter((p) => p.implemented).map((p) => p.value))
      .toEqual(['completions-compatible', 'responses-compatible', 'anthropic-compatible', 'anthropic-official']);
    expect(state.protocol).toBe('completions-compatible');
  });

  it('rejects an unknown panel and an unknown method', async () => {
    const { host } = hostWith(ENTRY);
    const contribution = gatewayConsole(host as never);
    await expect(contribution.invoke!('nope', 'state', [{ name: 'gw' }])).rejects.toThrow();
    await expect(contribution.invoke!('gateway', 'nope', [{ name: 'gw' }])).rejects.toThrow();
  });
});
