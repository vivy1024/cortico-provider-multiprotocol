/**
 * 模块自己的配置项,都在 `providers.<端点名>.options.` 下。控制台把标量项画在「模型与生成」
 * 之后的「协议」一段,对象项(请求头、请求体)画在高级一段。
 */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { LLMProviderEntry } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { PROTOCOLS } from './protocols.ts';
import { text } from './strings.ts';

export function moduleConfig(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[] {
  const S = text(language);
  const at = (key: string): string => `providers.${name}.options.${key}`;
  return [{
    id: `llm.${entry.kind}.${name}.protocol`,
    owner: `provider:${entry.kind}`,
    schema: {
      type: 'object',
      title: S.groupTitle,
      properties: {
        [at('protocol')]: { type: 'string', enum: [...PROTOCOLS], title: S.protocol, description: S.protocolDescription, 'x-hot': true },
        [at('systemInHistory')]: { type: 'boolean', title: S.systemInHistory, description: S.systemInHistoryDescription, 'x-hot': true },
        [at('catalogCurrency')]: { type: 'string', title: S.catalogCurrency, description: S.catalogCurrencyDescription, 'x-hot': true },
        [at('endpointPath')]: { type: 'string', title: S.endpointPath, description: S.endpointPathDescription, 'x-hot': true },
        [at('extraHeaders')]: { type: 'object', title: S.extraHeaders },
        [at('catalogHeaders')]: { type: 'object', title: S.catalogHeaders },
        [at('extraBody')]: { type: 'object', title: S.extraBody },
      },
    },
  }];
}
