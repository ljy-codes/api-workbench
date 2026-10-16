import { expect, it } from 'vitest';
import { detectImport } from './transfer';

function postman(reference = false) {
  return JSON.stringify({
    info: { name: '地址统一合成测试', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [
      { key: 'base', value: 'https://unified.example.com/api' },
      { key: 'tenantId', value: '42' },
    ],
    item: [{ name: '查询', request: {
      method: 'GET', url: '{{base}}/users',
      header: reference ? [{ key: 'X-Origin', value: '{{base}}' }] : [],
    } }],
  });
}

it('导入 Postman 后域名只在环境矩阵保存，模板式服务名不算请求引用', () => {
  const { workspace: w } = detectImport(postman());
  expect(w.bindings[0].baseUrl).toBe('https://unified.example.com/api');
  expect(w.requests[0].path).toBe('/users');
  expect(w.variables.some(v => v.name === 'base')).toBe(false);
  expect(w.variables.find(v => v.name === 'tenantId')?.value).toBe('42');
});

it('导入后仍用于 Header 的历史地址变量保留', () => {
  const { workspace: w } = detectImport(postman(true));
  expect(w.variables.find(v => v.name === 'base')?.value).toBe('https://unified.example.com/api');
  expect(w.requests[0].headers[0].value).toBe('{{base}}');
});
