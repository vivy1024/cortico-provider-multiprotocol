/** 面板文案。服务端按控制台语言取 `text()`;浏览器侧自己按 `ctx.language` 取 `panel`。 */

export type Language = 'zh' | 'en';

export interface PanelText {
  title: string;
  refresh: string;
  wire: string;
  protocol: string;
  requestPath: string;
  notImplemented: (protocol: string) => string;
  channels: string;
  quota: string;
  channel: string;
  kind: string;
  availability: string;
  credentials: string;
  concurrency: string;
  healthy: string;
  down: string;
  noChannels: string;
  balance: string;
  granted: string;
  available: string;
  unsupported: (reason: string) => string;
}

export const panel: Record<Language, PanelText> = {
  zh: {
    title: '网关状态',
    refresh: '刷新',
    wire: '生效方言',
    protocol: '协议',
    requestPath: '请求路径',
    notImplemented: (protocol) => `${protocol}(未实现)`,
    channels: '通道',
    quota: '配额',
    channel: '通道',
    kind: '类型',
    availability: '可用率',
    credentials: '凭据',
    concurrency: '并发',
    healthy: '正常',
    down: '不可用',
    noChannels: '网关没有报告任何通道。',
    balance: '余额',
    granted: '已授予',
    available: '可用',
    unsupported: (reason) => `这个端点不提供该信息(${reason})`,
  },
  en: {
    title: 'Gateway status',
    refresh: 'Refresh',
    wire: 'Active wire',
    protocol: 'Protocol',
    requestPath: 'Request path',
    notImplemented: (protocol) => `${protocol} (not implemented)`,
    channels: 'Channels',
    quota: 'Quota',
    channel: 'Channel',
    kind: 'Type',
    availability: 'Availability',
    credentials: 'Credentials',
    concurrency: 'Concurrency',
    healthy: 'Healthy',
    down: 'Down',
    noChannels: 'The gateway reported no channels.',
    balance: 'Balance',
    granted: 'Granted',
    available: 'Available',
    unsupported: (reason) => `This endpoint does not serve that (${reason})`,
  },
};

export interface ServerText {
  panelTitle: string;
  panelDescription: string;
  unknownPanel: string;
  unknownMethod: string;
  bodyRequired: string;
  instanceNameRequired: string;
  protocolUnknown: (value: string, known: string) => string;
  protocolNotImplemented: (protocol: string, implemented: string) => string;
}

const server: Record<Language, ServerText> = {
  zh: {
    panelTitle: '网关状态',
    panelDescription: '通道健康与配额,由网关自述;普通兼容端点没有这些路由。',
    unknownPanel: '未知面板',
    unknownMethod: '未知方法',
    bodyRequired: '请求体必须是对象',
    instanceNameRequired: '缺少端点名',
    protocolUnknown: (value, known) => `认不出的协议「${value}」;可选:${known}`,
    protocolNotImplemented: (protocol, implemented) => `协议「${protocol}」在这个包里还没有 wire 实现;已实现:${implemented}`,
  },
  en: {
    panelTitle: 'Gateway status',
    panelDescription: 'Channel health and quota as the gateway states them; plain compatible endpoints have no such routes.',
    unknownPanel: 'Unknown panel',
    unknownMethod: 'Unknown method',
    bodyRequired: 'The request body must be an object',
    instanceNameRequired: 'Endpoint name missing',
    protocolUnknown: (value, known) => `Unknown protocol "${value}"; expected one of: ${known}`,
    protocolNotImplemented: (protocol, implemented) => `Protocol "${protocol}" has no wire implementation in this package; implemented: ${implemented}`,
  },
};

export function text(language: Language): ServerText {
  return language === 'en' ? server.en : server.zh;
}
