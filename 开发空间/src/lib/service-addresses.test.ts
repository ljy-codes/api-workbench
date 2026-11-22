import { expect, it } from 'vitest';
import type { Workspace } from '../types';
import { demoWorkspace } from './workspace';
import { findServiceAddressVariables, unifyServiceAddresses } from './service-addresses';

function fixture() {
  const w = demoWorkspace();
  w.variables.push({ id: 'host', projectId: 'demo-project', scope: 'environment', ownerId: 'demo-dev', name: 'origin', value: w.bindings[0].baseUrl, isSecret: false });
  return w;
}

it('只合并无引用同地址环境变量，绑定、接口与源对象保持不变，重复执行稳定', () => {
  const w = fixture(), before = structuredClone(w);
  const next = unifyServiceAddresses(w);
  expect(next.variables.some(v => v.id === 'host')).toBe(false);
  expect(next.bindings).toBe(w.bindings);
  expect(next.requests).toBe(w.requests);
  expect(w).toEqual(before);
  expect(unifyServiceAddresses(next)).toBe(next);
});

it('截图中的无协议 IP 与 HTTP 绑定可合并，HTTPS 与 HTTP 不混同', () => {
  const w = fixture();
  w.bindings[0].baseUrl = 'http://10.0.0.1:12000';
  w.variables.at(-1)!.value = '10.0.0.1:12000';
  expect(unifyServiceAddresses(w).variables.some(v => v.id === 'host')).toBe(false);
  w.bindings[0].baseUrl = 'https://10.0.0.1:12000';
  expect(unifyServiceAddresses(w)).toBe(w);
});

it.each([
  ['接口路径', (w: Workspace) => { w.requests[0].path = '/{{ origin }}'; }],
  ['禁用参数', (w: Workspace) => { w.requests[0].query.push({ id: 'q', key: 'origin', value: '{{origin}}', enabled: false }); }],
  ['Headers 名称', (w: Workspace) => { w.requests[0].headers.push({ id: 'h', key: '{{origin}}', value: 'x', enabled: true }); }],
  ['鉴权', (w: Workspace) => { w.requests[0].auth = { kind: 'bearer', token: '{{origin}}' }; }],
  ['文本正文', (w: Workspace) => { w.requests[0].bodyType = 'text'; w.requests[0].body = '{{origin}}'; }],
  ['表单值', (w: Workspace) => { w.requests[0].form = [{ id: 'f', key: 'x', value: '{{origin}}', enabled: false, kind: 'text' }]; }],
  ['服务公共 Headers', (w: Workspace) => { w.services[0].headers = [{ id: 's', key: 'X-Origin', value: '{{origin}}', enabled: true }]; }],
  ['服务公共鉴权', (w: Workspace) => { w.services[0].auth = { kind: 'basic', username: '{{origin}}', password: '' }; }],
  ['其他变量', (w: Workspace) => { w.variables.push({ ...w.variables.at(-1)!, id: 'alias', name: 'alias', value: '{{origin}}' }); }],
  ['其他环境配置', (w: Workspace) => { w.requests[0].environmentConfigs = { 'demo-prod': { query: [], headers: [], auth: { kind: 'bearer', token: '{{origin}}' }, bodyType: 'none', body: '', timeoutMs: 1000 } }; }],
  ['JSON Unicode 转义', (w: Workspace) => { w.requests[0].bodyType = 'json'; w.requests[0].body = '{"origin":"\\u007b\\u007borigin\\u007d\\u007d"}'; }],
  ['环境配置中的 JSON Unicode 转义', (w: Workspace) => { w.requests[0].environmentConfigs = { 'demo-prod': { query: [], headers: [], bodyType: 'json', body: '{"origin":"\\u007b\\u007borigin}}"}', timeoutMs: 1000 } }; }],
] as const)('%s 中引用的地址变量继续保留', (_name, reference) => {
  const w = fixture();
  reference(w);
  expect(unifyServiceAddresses(w)).toBe(w);
});

it('服务名、接口名等描述文字中的占位符不被当作模板引用', () => {
  const w = fixture();
  w.services[0].name = '{{origin}}';
  w.requests[0].name = '{{origin}}';
  expect(unifyServiceAddresses(w).variables.some(v => v.id === 'host')).toBe(false);
});

it('秘密值、其他作用域、不同环境地址和普通变量均不合并', () => {
  const w = fixture();
  const address = w.variables.at(-1)!;
  w.variables = [
    { ...address, isSecret: true },
    { ...address, id: 'project', scope: 'project', ownerId: 'demo-project' },
    { ...address, id: 'environment', ownerId: 'demo-prod' },
    { ...address, id: 'other-value', name: 'other', value: 'https://other.example.com' },
    { ...address, id: 'business', name: 'tenantId', value: '42' },
  ];
  expect(unifyServiceAddresses(w)).toBe(w);
});

it('项目隔离：其他项目同名变量引用不阻止当前项目合并，外部项目地址不能匹配', () => {
  const w = fixture();
  w.projects.push({ id: 'other', name: '其他', activeEnvironmentId: 'other-env' });
  w.services.push({ id: 'other-service', projectId: 'other', name: '其他服务', headers: [{ id: 'h', key: 'X', value: '{{origin}}', enabled: true }] });
  w.environments.push({ id: 'other-env', projectId: 'other', name: '其他环境', isProduction: false });
  w.variables.push({ ...w.variables.at(-1)!, id: 'foreign-host', projectId: 'other', ownerId: 'other-env' });
  const next = unifyServiceAddresses(w);
  expect(next.variables.some(v => v.id === 'host')).toBe(false);
  expect(next.variables.some(v => v.id === 'foreign-host')).toBe(true);
});

it('保留异常重复名称，避免合并过程掩盖原有校验问题', () => {
  const w = fixture();
  w.variables.push({ ...w.variables.at(-1)!, id: 'duplicate', value: 'different' });
  expect(unifyServiceAddresses(w)).toBe(w);
});

it.each(['', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com?q=1', 'https://example.com/#x', '{{base}}', 'https://example.com\\path', 'https://example.com/\n'])('无效或含凭据/模板的地址不参与合并：%j', value => {
  const w = fixture();
  w.bindings[0].baseUrl = value;
  w.variables.at(-1)!.value = value;
  expect(findServiceAddressVariables(w)).toEqual([]);
  expect(unifyServiceAddresses(w)).toBe(w);
});

it.each([
  'https://api.example.com/./v1',
  'https://api.example.com/a/../v1',
  'https://api.example.com/%2e/v1',
  'https://api.example.com/%2e%2e/v1',
  'https://api.example.com/a%5cb',
  'https://api.example.com/%zz',
  'https://@api.example.com/v1',
  'https:///api.example.com/v1',
  'https://api.example.com/v1\u0000',
])('原生引擎拒绝的地址不会因 URL 规范化而被合并：%j', value => {
  const w = fixture();
  w.variables.at(-1)!.value = value;
  w.bindings[0].baseUrl = new URL(value).href;
  expect(findServiceAddressVariables(w)).toEqual([]);
  expect(unifyServiceAddresses(w)).toBe(w);
  w.bindings[0].baseUrl = value;
  expect(findServiceAddressVariables(w)).toEqual([]);
});
