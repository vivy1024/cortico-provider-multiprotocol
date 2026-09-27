import { afterEach, describe, expect, it, vi } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import PROVIDER from '../src/index.ts';
import { ChatCompletionsProvider } from '../src/native.ts';
import { AnthropicProvider } from '../src/anthropic/client.ts';

const HOST = {
  stateDir: '.',
  secret: () => 'k',
  readBlob: () => null,
  keepThinking: () => false,
  log: nullLogger(),
};

let seq = 0;
/** 每条用例一个地址,模块级的目录缓存不串到别的用例。 */
function entryWith(options?: Record<string, unknown>): LLMProviderEntry {
  return { kind: 'multiprotocol', baseUrl: `https://gateway${++seq}.example/v1`, secret: 'KEY', ...(options ? { options } : {}) };
}

function create(options?: Record<string, unknown>, entry = entryWith(options)) {
  return PROVIDER.create('gw', entry, HOST as never);
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('validateEntry and normalize', () => {
  it('rejects a protocol the module does not declare', () => {
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'grpc' }), 'zh')).toThrow(/grpc/);
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'codex-native' }), 'zh')).toThrow(/codex-native/);
  });

  it('accepts current values, 0.1 values and an absent protocol', () => {
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'anthropic-messages' }), 'zh')).not.toThrow();
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'anthropic-official' }), 'zh')).not.toThrow();
    expect(() => PROVIDER.validateEntry(entryWith(), 'zh')).not.toThrow();
  });

  it('migrates a 0.1 protocol value and leaves a current entry untouched', () => {
    expect(PROVIDER.normalize(entryWith({ protocol: 'anthropic-official' })).options)
      .toEqual({ protocol: 'anthropic-messages', systemInHistory: true });
    const current = entryWith({ protocol: 'openai-responses' });
    expect(PROVIDER.normalize(current)).toBe(current);
  });
});

describe('config', () => {
  it('declares the protocol and wire options under the endpoint options', () => {
    const [group] = PROVIDER.config('gw', entryWith(), 'zh');
    expect(Object.keys(group.schema.properties ?? {})).toEqual([
      'providers.gw.options.protocol', 'providers.gw.options.systemInHistory', 'providers.gw.options.catalogCurrency',
      'providers.gw.options.endpointPath', 'providers.gw.options.extraHeaders', 'providers.gw.options.catalogHeaders',
      'providers.gw.options.extraBody',
    ]);
    expect(group.schema.properties?.['providers.gw.options.protocol']?.enum)
      .toEqual(['openai-chat-completions', 'openai-responses', 'anthropic-messages']);
  });
});

describe('create', () => {
  it('builds the client the protocol names', () => {
    expect(create().client).toBeInstanceOf(ChatCompletionsProvider);
    expect(create({ protocol: 'openai-responses' }).client).toBeInstanceOf(ResponsesProvider);
    expect(create({ protocol: 'anthropic-messages' }).client).toBeInstanceOf(AnthropicProvider);
  });

  it('puts the wire and path into the compatibility key so credentials do not replay across protocols', () => {
    expect(create().compatibilityKey?.()).toEqual(['openai-chat-completions', '/chat/completions', 'gw']);
    expect(create({ protocol: 'anthropic-messages' }).compatibilityKey?.()).toEqual(['anthropic-messages', '/messages', 'gw']);
    expect(create({ protocol: 'openai-responses', endpointPath: '/v2/responses' }).compatibilityKey?.())
      .toEqual(['openai-responses', '/v2/responses', 'gw']);
  });

  it('sends catalog headers only when listing models, extra headers everywhere', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }));
    const instance = create({ extraHeaders: { 'X-Everywhere': '1' }, catalogHeaders: { 'X-Catalog': '1' } });
    await instance.listModels?.();
    await instance.client.respond({ model: 'm', input: 'hi' }, { onEvent: () => {} });
    const models = seen.filter((r) => r.url.endsWith('/models'));
    const generation = seen.find((r) => r.url.endsWith('/chat/completions'))!;
    expect(models.every((r) => r.headers['X-Catalog'] === '1' && r.headers['X-Everywhere'] === '1')).toBe(true);
    expect(generation.headers['X-Everywhere']).toBe('1');
    expect(generation.headers['X-Catalog']).toBeUndefined();
    expect(generation.headers.Authorization).toBe('Bearer k');
  });
});

describe('prices', () => {
  it('uses list prices only when the entry declares their currency', async () => {
    const pricing = { billingMode: 'token', tokenUnit: 1000000, input: 1, output: 4 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ id: 'm', pricing }] }))));
    const priced = entryWith({ catalogCurrency: 'CNY' });
    await create(undefined, priced).listModels?.();
    expect(PROVIDER.prices(priced, { model: 'm' })).toMatchObject([{ currency: 'CNY', models: ['m'] }]);
    const unpriced = entryWith();
    await create(undefined, unpriced).listModels?.();
    expect(PROVIDER.prices(unpriced, { model: 'm' })).toEqual([]);
  });
});
