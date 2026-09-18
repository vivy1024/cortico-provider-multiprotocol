import { describe, expect, it } from 'vitest';
import { Gateway, normalizeChannels } from '../src/gateway.ts';

const ENDPOINT = { baseUrl: 'https://gateway.example/v1', headers: { Authorization: 'Bearer k' } };

function stub(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
}

describe('normalizeChannels', () => {
  it('orders by channelType then channel, independent of input order', () => {
    const rows = normalizeChannels([
      { channel: 'kiro', channelType: 'kiro', availabilityRate: 0 },
      { channel: 'antigravity', channelType: 'antigravity', availabilityRate: 1 },
      { channel: 'b', channelType: 'openai', availabilityRate: 1 },
      { channel: 'a', channelType: 'openai', availabilityRate: 1 },
    ]);
    expect(rows.map((r) => `${r.channelType}/${r.channel}`)).toEqual([
      'antigravity/antigravity', 'kiro/kiro', 'openai/a', 'openai/b',
    ]);
  });

  it('keeps instances that share a channelType apart', () => {
    const rows = normalizeChannels([
      { channel: 'one', channelType: 'openai', availabilityRate: 1 },
      { channel: 'two', channelType: 'openai', availabilityRate: 0 },
    ]);
    expect(rows).toHaveLength(2);
  });

  it('accepts snake_case spellings', () => {
    const [row] = normalizeChannels([
      { channel: 'x', channel_type: 'openai', availability_rate: 0.5, available_credentials: 2, total_credentials: 3 },
    ]);
    expect(row).toMatchObject({ channelType: 'openai', availabilityRate: 0.5, availableCredentials: 2, totalCredentials: 3 });
  });

  it('drops rows without a channelType and tolerates a non-array', () => {
    expect(normalizeChannels([{ channel: 'x', availabilityRate: 1 }, null, 'nope'])).toEqual([]);
    expect(normalizeChannels(undefined)).toEqual([]);
  });

  it('defaults a missing availability rate to zero rather than NaN', () => {
    const [row] = normalizeChannels([{ channelType: 'openai' }]);
    expect(row?.availabilityRate).toBe(0);
  });
});

describe('Gateway', () => {
  it('reports channels when the route answers', async () => {
    const gateway = new Gateway(() => ENDPOINT, stub({
      channels: [{ channel: 'antigravity', channelType: 'antigravity', healthy: true, availabilityRate: 1 }],
    }));
    const probe = await gateway.channels();
    expect(probe.supported).toBe(true);
    if (probe.supported) expect(probe.value[0]?.healthy).toBe(true);
  });

  it('reports unsupported with the status when the route is absent', async () => {
    const gateway = new Gateway(() => ENDPOINT, (async () => new Response('nope', { status: 404 })) as typeof fetch);
    const probe = await gateway.channels();
    expect(probe).toEqual({ supported: false, reason: 'GET /channels/health 404' });
  });

  it('reports unsupported instead of throwing when the endpoint is unreachable', async () => {
    const gateway = new Gateway(() => ENDPOINT, (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    expect(await gateway.quota()).toEqual({ supported: false, reason: 'ECONNREFUSED' });
  });

  it('reads the quota figures the gateway states', async () => {
    const gateway = new Gateway(() => ENDPOINT, stub({
      balance: 9178.91, totalGranted: 9999, totalAvailable: 9178.91, unitName: '元',
    }));
    const probe = await gateway.quota();
    expect(probe.supported).toBe(true);
    if (probe.supported) expect(probe.value).toEqual({ balance: 9178.91, totalGranted: 9999, totalAvailable: 9178.91, unitName: '元' });
  });

  it('leaves absent quota figures out rather than defaulting them to zero', async () => {
    const gateway = new Gateway(() => ENDPOINT, stub({ balance: 5 }));
    const probe = await gateway.quota();
    if (probe.supported) expect(probe.value).toEqual({ balance: 5 });
  });
});
