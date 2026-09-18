import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/catalog.ts';

const ENDPOINT = { baseUrl: 'https://gateway.example/v1', headers: { Authorization: 'Bearer k' } };

function stub(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

describe('ModelCatalog', () => {
  it('reads the OpenAI-standard data[] shape', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({
      object: 'list',
      data: [
        { id: 'b-model', object: 'model', owned_by: 'x' },
        { id: 'a-model', object: 'model', owned_by: 'x' },
      ],
    }));
    expect(await catalog.list()).toEqual([{ id: 'a-model' }, { id: 'b-model' }]);
    expect(catalog.contextWindow('a-model')).toBeUndefined();
  });

  it('reads context windows from the metadata-carrying models[] shape', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({
      models: [{ id: 'antigravity:gemini-3.7-flash-high', contextWindow: 1048576, channelType: 'anthropic' }],
      modelHash: 'sha256:abc',
    }));
    expect(await catalog.list()).toEqual([{ id: 'antigravity:gemini-3.7-flash-high', contextWindow: 1048576 }]);
    expect(catalog.contextWindow('antigravity:gemini-3.7-flash-high')).toBe(1048576);
  });

  it('accepts the snake_case context length spelling', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({ data: [{ id: 'm', context_length: 128000 }] }));
    await catalog.list();
    expect(catalog.contextWindow('m')).toBe(128000);
  });

  it('skips rows without a usable id and windows that are not positive integers', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({
      data: [{ id: '' }, { object: 'model' }, null, { id: 'ok', contextWindow: 0 }, { id: 'neg', contextWindow: -1 }],
    }));
    expect(await catalog.list()).toEqual([{ id: 'neg' }, { id: 'ok' }]);
    expect(catalog.contextWindow('ok')).toBeUndefined();
  });

  it('reports the status and body when the listing fails', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, (async () =>
      new Response('upstream down', { status: 503 })) as typeof fetch);
    await expect(catalog.list()).rejects.toThrow(/503.*upstream down/s);
  });

  it('rejects a response that carries neither array', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({ object: 'list' }));
    await expect(catalog.list()).rejects.toThrow(/模型数组/);
  });

  it('unknown models have no remembered window', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({ data: [{ id: 'm' }] }));
    await catalog.list();
    expect(catalog.contextWindow('never-listed')).toBeUndefined();
  });
});
