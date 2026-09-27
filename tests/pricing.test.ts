import { describe, expect, it } from 'vitest';
import { ModelCatalog, readPricing } from '../src/catalog.ts';

const ENDPOINT = { baseUrl: 'https://gateway.example/v1', headers: {} };

function stub(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

const PRICING = {
  unitName: 'unit', billingMode: 'token', tokenUnit: 1000000, billable: true, pricingConfigured: true,
  input: 1, output: 4, cacheCreationInput: 1, cacheReadInput: 0.1, multiplier: 1,
  longContextThresholdTokens: 0, longContextMode: 'full',
};

describe('catalog pricing', () => {
  it('maps the catalog fields onto the framework meters in the declared currency', () => {
    expect(readPricing(PRICING, 'CNY')).toEqual({
      currency: 'CNY',
      rules: [
        { meter: 'uncachedInput', perMillion: 1 },
        { meter: 'output', perMillion: 4 },
        { meter: 'cachedInput', perMillion: 0.1 },
        { meter: 'detail:cacheCreationInput', perMillion: 1 },
      ],
    });
  });

  it('rescales a different token unit and applies the multiplier', () => {
    const pricing = readPricing({ ...PRICING, tokenUnit: 1000, input: 0.001, output: 0.004, multiplier: 2 }, 'USD');
    expect(pricing?.rules.find((r) => r.meter === 'uncachedInput')?.perMillion).toBeCloseTo(2);
    expect(pricing?.rules.find((r) => r.meter === 'output')?.perMillion).toBeCloseTo(8);
  });

  it('quotes nothing for an unbillable entry or one billed per call rather than per token', () => {
    expect(readPricing({ ...PRICING, billable: false }, 'CNY')).toBeUndefined();
    expect(readPricing({ ...PRICING, pricingConfigured: false }, 'CNY')).toBeUndefined();
    expect(readPricing({ ...PRICING, billingMode: 'credit' }, 'CNY')).toBeUndefined();
  });

  it('turns a whole-request long-context tier into an input band, falling back field by field', () => {
    const pricing = readPricing({ ...PRICING, longContextThresholdTokens: 200000, longContextInput: 2, longContextOutput: 0 }, 'USD');
    expect(pricing?.inputBands).toEqual([{ from: 200000, rules: [
      { meter: 'uncachedInput', perMillion: 2 },
      { meter: 'output', perMillion: 4 },
      { meter: 'cachedInput', perMillion: 0.1 },
      { meter: 'detail:cacheCreationInput', perMillion: 1 },
    ] }]);
    expect(readPricing({ ...PRICING, longContextThresholdTokens: 200000, longContextMode: 'excess' }, 'USD')).toBeUndefined();
  });

  it('reads the pricing a listed model carries and nothing for a plain OpenAI catalog', async () => {
    const catalog = new ModelCatalog(() => ENDPOINT, stub({ models: [{ id: 'vendor:model-a', pricing: PRICING }] }));
    await catalog.list();
    expect(catalog.pricing('vendor:model-a', 'CNY')?.currency).toBe('CNY');
    const plain = new ModelCatalog(() => ENDPOINT, stub({ data: [{ id: 'model-b' }] }));
    await plain.list();
    expect(plain.pricing('model-b', 'USD')).toBeUndefined();
  });
});
