import { describe, expect, it } from 'vitest';
import { nullLogger } from 'cortico/core/util.ts';
import { ResponsesProvider } from 'cortico/providers/openai-responses-compat/native.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import PROVIDER from '../src/index.ts';
import { ChatCompletionsProvider } from '../src/native.ts';

const HOST = {
  stateDir: '.',
  secret: () => 'k',
  readBlob: () => null,
  keepThinking: () => false,
  log: nullLogger(),
};

function entryWith(options?: Record<string, unknown>): LLMProviderEntry {
  return { kind: 'multiprotocol', baseUrl: 'https://gateway.example/v1', ...(options ? { options } : {}) };
}

function create(options?: Record<string, unknown>) {
  return PROVIDER.create('gw', entryWith(options), HOST as never);
}

describe('validateEntry', () => {
  it('rejects a protocol the module does not declare', () => {
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'grpc' }), 'zh')).toThrow(/grpc/);
  });

  it('accepts a declared protocol and an absent one', () => {
    expect(() => PROVIDER.validateEntry(entryWith({ protocol: 'anthropic-official' }), 'zh')).not.toThrow();
    expect(() => PROVIDER.validateEntry(entryWith(), 'zh')).not.toThrow();
  });
});

describe('availability', () => {
  it('is ready for the wires this package implements', () => {
    expect(PROVIDER.availability('gw', entryWith(), 'zh')).toEqual({ ready: true });
    expect(PROVIDER.availability('gw', entryWith({ protocol: 'responses-compatible' }), 'zh')).toEqual({ ready: true });
  });

  it('refuses a declared but unimplemented wire, naming what is implemented', () => {
    const verdict = PROVIDER.availability('gw', entryWith({ protocol: 'gemini-interactions' }), 'zh');
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toContain('gemini-interactions');
    expect(verdict.reason).toContain('completions-compatible');
  });
});

describe('create', () => {
  it('builds a Chat Completions client by default', () => {
    expect(create().client).toBeInstanceOf(ChatCompletionsProvider);
  });

  it('builds a Responses client when the protocol says so', () => {
    expect(create({ protocol: 'responses-compatible' }).client).toBeInstanceOf(ResponsesProvider);
  });

  it('puts the wire into the compatibility key so credentials do not replay across protocols', () => {
    const completions = create().compatibilityKey?.();
    const responses = create({ protocol: 'responses-compatible' }).compatibilityKey?.();
    expect(completions).toEqual(['completions-compatible', '/chat/completions', 'gw']);
    expect(responses).toEqual(['responses-compatible', '/responses', 'gw']);
    expect(completions).not.toEqual(responses);
  });

  it('pins the Chat Completions path even when a responses path sits in options', () => {
    expect(create({ endpointPath: '/responses' }).compatibilityKey?.())
      .toEqual(['completions-compatible', '/chat/completions', 'gw']);
  });

  it('honours a custom path on the Responses wire', () => {
    expect(create({ protocol: 'responses-compatible', endpointPath: '/v1/responses' }).compatibilityKey?.())
      .toEqual(['responses-compatible', '/v1/responses', 'gw']);
  });

  it('throws for a wire it has no implementation for', () => {
    expect(() => create({ protocol: 'codex-native' })).toThrow(/codex-native/);
  });
});
