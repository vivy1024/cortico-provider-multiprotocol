import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/catalog.ts';

const ENDPOINT = { baseUrl: 'https://gateway.example/v1', headers: {} };

function stub(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

/** 取自真实网关目录的一条,只留计价相关字段。 */
const ROW = {
  id: 'antigravity:gemini-3.7-flash-high',
  contextWindow: 1048576,
  pricing: {
    unitName: '元', tokenUnit: 1000000, billable: true, pricingConfigured: true,
    input: 1, output: 4, cacheCreationInput: 1, cacheReadInput: 0.1, multiplier: 1,
  },
};

async function pricingOf(row: Record<string, unknown>) {
  const catalog = new ModelCatalog(() => ENDPOINT, stub({ models: [row] }));
  await catalog.list();
  return catalog.pricing(String(row.id));
}

describe('catalog pricing', () => {
  it('maps the gateway meters onto the framework ones', async () => {
    expect(await pricingOf(ROW)).toEqual({
      currency: 'CNY',
      rules: [
        { meter: 'uncachedInput', perMillion: 1 },
        { meter: 'output', perMillion: 4 },
        { meter: 'cachedInput', perMillion: 0.1 },
        { meter: 'detail:cacheCreationInput', perMillion: 1 },
      ],
    });
  });

  it('rescales when the catalog quotes per a different token unit', async () => {
    const row = { ...ROW, pricing: { ...ROW.pricing, tokenUnit: 1000, input: 0.001, output: 0.004 } };
    const pricing = await pricingOf(row);
    expect(pricing?.rules.find((r) => r.meter === 'uncachedInput')?.perMillion).toBeCloseTo(1);
    expect(pricing?.rules.find((r) => r.meter === 'output')?.perMillion).toBeCloseTo(4);
  });

  it('applies the channel multiplier', async () => {
    const row = { ...ROW, pricing: { ...ROW.pricing, multiplier: 2 } };
    const pricing = await pricingOf(row);
    expect(pricing?.rules.find((r) => r.meter === 'output')?.perMillion).toBe(8);
  });

  it('quotes nothing when the catalog says the model is not billable', async () => {
    expect(await pricingOf({ ...ROW, pricing: { ...ROW.pricing, billable: false } })).toBeUndefined();
    expect(await pricingOf({ ...ROW, pricing: { ...ROW.pricing, pricingConfigured: false } })).toBeUndefined();
  });

  it('refuses to guess a currency it does not recognise', async () => {
    expect(await pricingOf({ ...ROW, pricing: { ...ROW.pricing, unitName: 'credits' } })).toBeUndefined();
    expect(await pricingOf({ ...ROW, pricing: { ...ROW.pricing, unitName: 'USD' } }))
      .toMatchObject({ currency: 'USD' });
  });

  it('has no pricing for a plain OpenAI catalog', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({ data: [{ id: 'gpt-x' }] }));
    await catalog.list();
    expect(catalog.pricing('gpt-x')).toBeUndefined();
  });
});
