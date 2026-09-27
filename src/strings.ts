/** 控制台与报错文案,按控制台语言取。 */

import type { Language } from 'cortico/core/language.ts';

export interface Text {
  groupTitle: string;
  protocol: string;
  protocolDescription: string;
  systemInHistory: string;
  systemInHistoryDescription: string;
  catalogCurrency: string;
  catalogCurrencyDescription: string;
  endpointPath: string;
  endpointPathDescription: string;
  extraHeaders: string;
  catalogHeaders: string;
  extraBody: string;
  protocolUnknown: (value: string, known: string) => string;
}

const TEXT: Record<Language, Text> = {
  zh: {
    groupTitle: '协议',
    protocol: '协议',
    protocolDescription:
      'openai-chat-completions:POST /chat/completions,多数兼容服务都支持。'
      + 'openai-responses:POST /responses,OpenAI Responses 接口。'
      + 'anthropic-messages:POST /messages,Anthropic Messages 接口,支持思考签名重放与提示缓存。',
    systemInHistory: '对话中段保留 system 角色',
    systemInHistoryDescription: '仅 anthropic-messages。官方接口接受对话中段的 system 消息;多数兼容端点不接受,关闭时这些消息以 user 角色发出,位置不变。',
    catalogCurrency: '目录报价币种',
    catalogCurrencyDescription: '模型列表若附带价格,按这个币种记账(如 CNY、USD)。留空不采用列表里的价格;计价里自填的价格优先。',
    endpointPath: '请求路径',
    endpointPathDescription: '相对 API 地址的路径,以 / 开头。留空用协议默认:/chat/completions、/responses、/messages。',
    extraHeaders: '附加请求头(JSON object),每个请求都带',
    catalogHeaders: '目录请求头(JSON object),只在获取模型列表时带',
    extraBody: '附加请求体(JSON object),并入每次生成请求',
    protocolUnknown: (value, known) => `认不出的协议「${value}」;可选:${known}`,
  },
  en: {
    groupTitle: 'Protocol',
    protocol: 'Protocol',
    protocolDescription:
      'openai-chat-completions: POST /chat/completions, supported by most compatible services. '
      + 'openai-responses: POST /responses, the OpenAI Responses API. '
      + 'anthropic-messages: POST /messages, the Anthropic Messages API, with signed thinking replay and prompt caching.',
    systemInHistory: 'Keep the system role mid-conversation',
    systemInHistoryDescription: 'anthropic-messages only. The official API accepts system messages mid-conversation; most compatible endpoints do not, and with this off those messages go out as user messages in the same place.',
    catalogCurrency: 'Catalog price currency',
    catalogCurrencyDescription: 'When the model list carries prices, bill them in this currency (e.g. USD, CNY). Empty: list prices are not used; prices entered under pricing take precedence.',
    endpointPath: 'Request path',
    endpointPathDescription: 'Path relative to the API address, starting with /. Empty: the protocol default, /chat/completions, /responses or /messages.',
    extraHeaders: 'Extra headers (JSON object), sent on every request',
    catalogHeaders: 'Catalog headers (JSON object), sent only when listing models',
    extraBody: 'Extra request body (JSON object), merged into every generation request',
    protocolUnknown: (value, known) => `Unknown protocol "${value}"; expected one of: ${known}`,
  },
};

export function text(language: Language): Text {
  return TEXT[language] ?? TEXT.zh;
}
