import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTOCOL, IMPLEMENTED, PROTOCOLS, endpointPathFor, isProtocol, readProtocol } from '../src/protocols.ts';

describe('protocol selection', () => {
  it('defaults to Chat Completions when nothing is configured', () => {
    expect(readProtocol(undefined)).toBe('completions-compatible');
    expect(readProtocol({})).toBe(DEFAULT_PROTOCOL);
  });

  it('ignores an unrecognised value rather than failing the lookup', () => {
    expect(readProtocol({ protocol: 'nope' })).toBe(DEFAULT_PROTOCOL);
    expect(readProtocol({ protocol: 42 })).toBe(DEFAULT_PROTOCOL);
  });

  it('accepts every declared protocol', () => {
    for (const p of PROTOCOLS) expect(readProtocol({ protocol: p })).toBe(p);
    expect(isProtocol('anthropic-official')).toBe(true);
    expect(isProtocol('anthropic')).toBe(false);
  });

  it('declares the wires this package implements', () => {
    expect([...IMPLEMENTED]).toEqual([
      'completions-compatible', 'responses-compatible', 'anthropic-compatible', 'anthropic-official',
    ]);
  });
});

describe('endpointPathFor', () => {
  it('pins Chat Completions regardless of the configured path', () => {
    expect(endpointPathFor('completions-compatible', { endpointPath: '/responses' })).toBe('/chat/completions');
    expect(endpointPathFor('completions-compatible', undefined)).toBe('/chat/completions');
  });

  it('lets the Responses family take the configured path', () => {
    expect(endpointPathFor('responses-compatible', { endpointPath: '/v1/responses' })).toBe('/v1/responses');
    expect(endpointPathFor('responses-compatible', undefined)).toBe('/responses');
  });

  it('rejects a path that is not rooted and falls back to the default', () => {
    expect(endpointPathFor('responses-compatible', { endpointPath: 'responses' })).toBe('/responses');
    expect(endpointPathFor('responses-compatible', { endpointPath: '' })).toBe('/responses');
  });
});
