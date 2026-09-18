/**
 * 端点页上的网关状态面板。数据全部现取自网关自述的路由,面板不存任何状态;
 * 端点不提供这些路由时返回不支持与原因,由客户端照原样显示。
 */
import type { ConsolePageContribution } from 'cortico/web/shared/console-protocol.ts';
import type { ProviderConsoleHost } from 'cortico/providers/console/types.ts';
import type { Gateway, GatewayState } from '../gateway.ts';
import { IMPLEMENTED, PROTOCOLS, isProtocol, endpointPathFor, readProtocol } from '../protocols.ts';
import { text } from './strings.ts';

export interface Control {
  gateway: Gateway;
}

const CHOICES = PROTOCOLS.map((value) => ({ value, implemented: IMPLEMENTED.includes(value) }));

export function gatewayConsole(host: ProviderConsoleHost): Partial<ConsolePageContribution> {
  const S = text(host.language);
  const entryOf = (name: string) => {
    const found = host.entries().find((item) => item.name === name);
    if (!found) throw new Error(S.instanceNameRequired);
    return found.entry;
  };
  return {
    panels: [{ id: 'gateway', title: S.panelTitle, description: S.panelDescription, slot: 'instance' }],
    invoke: async (panel, method, args) => {
      if (panel !== 'gateway') throw new Error(S.unknownPanel);
      const [raw] = args;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(S.bodyRequired);
      const body = raw as Record<string, unknown>;
      if (typeof body.name !== 'string') throw new Error(S.instanceNameRequired);
      const name = body.name;

      if (method === 'setProtocol') {
        const value = body.protocol;
        if (!isProtocol(value)) throw new Error(S.protocolUnknown(String(value), PROTOCOLS.join(' / ')));
        const entry = entryOf(name);
        host.save(name, { ...entry, options: { ...entry.options, protocol: value } });
        return { ok: true };
      }

      if (method !== 'state') throw new Error(S.unknownMethod);
      const control = host.instance(name).control as Control | undefined;
      if (!control?.gateway) throw new Error(S.unknownMethod);
      const [channels, quota] = await Promise.all([control.gateway.channels(), control.gateway.quota()]);
      const currentEntry = entryOf(name);
      const currentProtocol = readProtocol(currentEntry.options);
      const currentPath = endpointPathFor(currentProtocol, currentEntry.options);
      return {
        name,
        protocol: currentProtocol,
        endpointPath: currentPath,
        protocols: CHOICES,
        channels,
        quota,
      } satisfies GatewayState;
    },
  };
}
