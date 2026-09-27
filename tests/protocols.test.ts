import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTOCOL, PROTOCOLS, endpointPathFor, isKnownProtocol, isProtocol, migrateOptions, protocolForHint, readProtocol,
} from '../src/protocols.ts';

describe('protocol selection', () => {
  it('defaults to Chat Completions when nothing is configured', () => {
    expect(readProtocol(undefined)).toBe('openai-chat-completions');
    expect(readProtocol({})).toBe(DEFAULT_PROTOCOL);
  });

  it('ignores an unrecognised value rather than failing the lookup', () => {
    expect(readProtocol({ protocol: 'nope' })).toBe(DEFAULT_PROTOCOL);
    expect(readProtocol({ protocol: 42 })).toBe(DEFAULT_PROTOCOL);
  });

  it('accepts every declared protocol and nothing else as current', () => {
    for (const p of PROTOCOLS) expect(readProtocol({ protocol: p })).toBe(p);
    expect(isProtocol('anthropic-messages')).toBe(true);
    expect(isProtocol('anthropic')).toBe(false);
  });

  it('reads and migrates the 0.1 values', () => {
    expect(readProtocol({ protocol: 'anthropic-compatible' })).toBe('anthropic-messages');
    expect(readProtocol({ protocol: 'responses-compatible' })).toBe('openai-responses');
    expect(isKnownProtocol('completions-compatible')).toBe(true);
    expect(isKnownProtocol('codex-native')).toBe(false);
    expect(migrateOptions({ protocol: 'anthropic-official', endpointPath: '/messages' }))
      .toEqual({ protocol: 'anthropic-messages', systemInHistory: true, endpointPath: '/messages' });
    const current = { protocol: 'openai-responses' };
    expect(migrateOptions(current)).toBe(current);
  });
});

describe('endpointPathFor', () => {
  it('uses the protocol default when no path is configured', () => {
    expect(endpointPathFor('openai-chat-completions', undefined)).toBe('/chat/completions');
    expect(endpointPathFor('openai-responses', {})).toBe('/responses');
    expect(endpointPathFor('anthropic-messages', undefined)).toBe('/messages');
  });

  it('takes a rooted configured path on every protocol', () => {
    expect(endpointPathFor('openai-chat-completions', { endpointPath: '/v2/chat' })).toBe('/v2/chat');
    expect(endpointPathFor('anthropic-messages', { endpointPath: '/claude/messages' })).toBe('/claude/messages');
  });

  it('falls back to the default for a path that is not rooted', () => {
    expect(endpointPathFor('openai-responses', { endpointPath: 'responses' })).toBe('/responses');
    expect(endpointPathFor('openai-responses', { endpointPath: '' })).toBe('/responses');
  });
});

describe('protocolForHint', () => {
  it('maps the common catalog spellings and leaves the rest unmapped', () => {
    expect(protocolForHint('anthropic')).toBe('anthropic-messages');
    expect(protocolForHint('Responses')).toBe('openai-responses');
    expect(protocolForHint('openai')).toBe('openai-chat-completions');
    expect(protocolForHint('vendor-private')).toBeUndefined();
    expect(protocolForHint(undefined)).toBeUndefined();
  });
});
