import { describe, expect, it } from 'vitest';
import type { RequestHistoryEntry } from '../types';
import { demoWorkspace } from './workspace';
import { buildInvestigationReport } from './investigation-report';

function record(): RequestHistoryEntry {
  return {
    id: 'report-run', projectId: 'demo-project', projectName: '本地项目',
    environmentId: 'demo-dev', environmentName: '开发', serviceName: '服务',
    startedAt: 0, finishedAt: 100, url: 'https://example.test/users?access_token=url-secret&uid=private-query',
    request: { ...demoWorkspace().requests[0], bodyType: 'json',
      body: '{"password":"request-secret","id":9223372036854775807}',
      headers: [{ id: 'h', key: 'X-Token', value: 'header-secret', enabled: true }] },
    temporaryVariables: [{ id: 't', key: 'any', value: 'temporary-secret', enabled: true }],
    response: { executionId: 'report-run', status: 200, statusText: 'OK', durationMs: 100,
      sizeBytes: 100, truncated: false, environmentName: '开发', url: 'https://example.test/users',
      body: '{"data":{"refreshToken":"response-secret","id":9223372036854775807,"count":1.2300},"message":"ok"}',
      headers: [{ id: 'cookie', key: 'Set-Cookie', value: 'session=cookie-secret', enabled: true },
        { id: 'trace', key: 'x-trace-id', value: 'safe-trace', enabled: true }] },
  };
}

function responseBody(report: { preview: string; html: string }): string {
  const body = report.preview.split('响应正文\n')[1].split('\n\n复现模板')[0];
  const document = new DOMParser().parseFromString(report.html, 'text/html');
  const section = [...document.querySelectorAll('section')].find(item => item.querySelector('h2')?.textContent === '响应正文');
  expect(section?.querySelector('pre')?.textContent).toBe(body);
  return body;
}

describe('HTML 排查包导出边界', () => {
  it('默认不含正文、响应 Headers、临时变量、URL 参数和凭据', () => {
    const report = buildInvestigationReport(record(), {});
    for (const secret of ['request-secret', 'response-secret', 'header-secret', 'temporary-secret', 'url-secret', 'private-query', 'cookie-secret']) {
      expect(report.html).not.toContain(secret);
      expect(report.preview).not.toContain(secret);
    }
    expect(report.preview).toContain('未包含响应正文');
    expect(report.preview).not.toContain('safe-trace');
    expect(report.preview).toContain('cURL');
  });

  it('主动包含正文时递归遮蔽凭据，精确数字不丢失', () => {
    const report = buildInvestigationReport(record(), { includeRequestBody: true, includeResponseBody: true, includeResponseHeaders: true });
    expect(report.preview).toContain('9223372036854775807');
    expect(report.preview).toContain('1.2300');
    expect(report.preview).toContain('safe-trace');
    for (const secret of ['request-secret', 'response-secret', 'header-secret', 'cookie-secret']) expect(report.html).not.toContain(secret);
  });

  it.each(['json', 'form', 'multipart'] as const)('%s 请求中的密码即使在响应普通字段、Header、步骤回显也隐藏', bodyType => {
    const entry = record();
    const secret = 'BODY_SECRET_7f29';
    entry.request.bodyType = bodyType;
    entry.request.body = '{"nested":{"password":"BODY_SECRET_7f29"}}';
    entry.request.form = [{ id: 'password', key: 'password', value: secret, enabled: true, kind: 'text' }];
    entry.response!.body = JSON.stringify({ message: secret, [secret]: 'ordinary-value', ordinary: 'safe-value' });
    entry.response!.headers = [{ id: 'echo', key: 'X-Echo', value: secret, enabled: true }];
    const options = { includeResponseBody: true, includeResponseHeaders: true, steps: `回显 ${secret}` };
    const before = JSON.stringify({ entry, options });
    const report = buildInvestigationReport(entry, options);
    for (const text of [report.preview, report.html]) expect(text).not.toContain(secret);
    expect(JSON.parse(responseBody(report))).toEqual({
      message: '[已隐藏]', '[已隐藏]': '[已隐藏]', ordinary: 'safe-value',
    });
    expect(JSON.stringify({ entry, options })).toBe(before);
  });

  it('JSON 敏感字段的复合值和精确数字在其他响应字段回显时统一隐藏', () => {
    const entry = record();
    entry.request.query = [];
    entry.request.body = '{"credential":{"values":["NESTED_SECRET_19c2",7788992233]},"ordinary":9223372036854775807}';
    entry.response!.body = '{"message":"NESTED_SECRET_19c2","numericEcho":7.788992233e9,"ordinary":9223372036854775807,"decimal":1.2300}';
    const report = buildInvestigationReport(entry, { includeResponseBody: true });
    expect(JSON.parse(responseBody(report))).toMatchObject({
      message: '[已隐藏]', numericEcho: '[已隐藏]',
    });
    expect(responseBody(report)).toContain('9223372036854775807');
    expect(responseBody(report)).toContain('1.2300');
    expect(report.html).not.toContain('NESTED_SECRET_19c2');
  });

  it.each(['count', 'characters', 'invalid-json'] as const)('请求正文秘密超出 %s 脱敏能力时省略回显正文', budget => {
    const entry = record();
    if (budget === 'invalid-json') entry.request.body = '{"password":"BODY_SECRET_7f29"';
    else if (budget === 'characters') entry.request.body = JSON.stringify({ password: 'x'.repeat(20_001) });
    else entry.request.body = JSON.stringify({ credential: Array.from({ length: 129 }, (_, i) => `private-body-value-${i}`) });
    entry.response!.body = '{"message":"BODY_SECRET_7f29","other":"private-body-value-128"}';
    const report = buildInvestigationReport(entry, { includeResponseBody: true });
    expect(responseBody(report)).toContain('省略');
    expect(report.html).not.toContain('BODY_SECRET_7f29');
    expect(report.html).not.toContain('private-body-value-128');
  });

  it('恶意现象、步骤、响应文本均作为静态文本，不执行 HTML', () => {
    const entry = record();
    entry.response!.body = '{"message":"<img src=x onerror=alert(1)>"}';
    const report = buildInvestigationReport(entry, { symptom: '</pre><script>alert(1)</script>', steps: '<svg onload=alert(1)>', includeResponseBody: true });
    expect(report.html).not.toContain('<script>');
    expect(report.html).not.toContain('<img ');
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.html).toContain('Content-Security-Policy');
    expect(report.html).toContain("default-src 'none'");
  });

  it('非 JSON、截断及超出解析预算的正文被省略，不能携带未处理明文', () => {
    for (const text of ['password=private-plaintext', '{"token":"broken-secret"', 'x'.repeat(1_000_001)]) {
      const entry = record();
      entry.response!.body = text;
      const report = buildInvestigationReport(entry, { includeResponseBody: true });
      expect(report.preview).toContain('无法安全解析');
      expect(report.html).not.toContain('private-plaintext');
      expect(report.html).not.toContain('broken-secret');
    }
    const entry = record();
    entry.response!.truncated = true;
    expect(buildInvestigationReport(entry, { includeResponseBody: true }).preview).toContain('响应不完整');
  });

  it('不会把上传文件路径和其他环境配置打进报告', () => {
    const entry = record();
    entry.request.bodyType = 'multipart';
    entry.request.form = [{ id: 'file', key: 'upload', kind: 'file', enabled: true, value: 'C:\\private\\data.csv' }];
    entry.request.environmentConfigs = { prod: { query: [], headers: [], body: 'prod-secret', bodyType: 'text', timeoutMs: 100 } };
    const report = buildInvestigationReport(entry, { includeRequestBody: true });
    expect(report.html).not.toContain('data.csv');
    expect(report.html).not.toContain('prod-secret');
    expect(report.preview).toContain('文件需重新选择');
  });

  it('统一隐藏所有文本中新 URL 的 userinfo、查询名值和 fragment', () => {
    const entry = record();
    const callback = 'https://oauth-user:oauth-password@login.example.test/callback?code=OAUTH_CODE_7e21&state=STATE_2f91#oauth-fragment';
    const download = 'https://storage.example.test/archive?X-Amz-Credential=AWS_CRED_7c32&X-Amz-Signature=SIGNED_8d43\\SIGNED_TAIL#download-fragment';
    entry.projectName = callback;
    entry.serviceName = `下载 ${download}`;
    entry.request.name = callback;
    entry.response!.body = JSON.stringify({ downloadUrl: download, message: `跳转到 ${callback}`, [callback]: 'hidden-value', links: [callback], ordinary: 'ordinary-value' });
    entry.response!.headers = [{ id: 'location', key: 'Location', value: callback, enabled: true }];
    const report = buildInvestigationReport(entry, {
      includeResponseBody: true, includeResponseHeaders: true,
      symptom: `签名地址 ${download}`, steps: `打开 (${callback})`,
    });
    for (const text of [report.preview, report.html]) {
      for (const secret of [
        'oauth-user', 'oauth-password', 'code=', 'state=', 'OAUTH_CODE_7e21', 'STATE_2f91', 'oauth-fragment',
        'X-Amz-Credential', 'X-Amz-Signature', 'AWS_CRED_7c32', 'SIGNED_8d43', 'SIGNED_TAIL', 'download-fragment',
      ]) expect(text).not.toContain(secret);
    }
    expect(report.preview).toContain('https://login.example.test/callback?parameter=[已隐藏]');
    expect(report.preview).toContain('https://storage.example.test/archive?parameter=[已隐藏]');
    expect(responseBody(report)).toContain('ordinary-value');
  });

  it('相对重定向、协议相对 URL、JSON 转义 URL 也不携带新凭据', () => {
    const entry = record();
    entry.response!.headers = [
      { id: 'location', key: 'Location', value: '/callback?code=RELATIVE_CODE&state=RELATIVE_STATE#relative-fragment', enabled: true },
      { id: 'next', key: 'X-Next', value: '//network-user:network-password@login.example.test/next?private-name=NETWORK_CODE#network-fragment', enabled: true },
    ];
    entry.response!.body = String.raw`{"next":"https:\u002f\u002flogin.example.test/callback?code=ESCAPED_CODE\u0026state=ESCAPED_STATE#escaped-fragment"}`;
    const report = buildInvestigationReport(entry, {
      includeResponseHeaders: true, includeResponseBody: true,
      steps: '重新打开 ?code=QUERY_ONLY_CODE#query-fragment',
    });
    for (const text of [report.preview, report.html]) {
      for (const secret of [
        'RELATIVE_CODE', 'RELATIVE_STATE', 'relative-fragment', 'network-user', 'network-password', 'private-name',
        'NETWORK_CODE', 'network-fragment', 'ESCAPED_CODE', 'ESCAPED_STATE', 'escaped-fragment', 'QUERY_ONLY_CODE', 'query-fragment',
      ]) expect(text).not.toContain(secret);
    }
    expect(report.preview).toContain('/callback?parameter=[已隐藏]');
    expect(responseBody(report)).toContain('login.example.test/callback');
  });

  it.each([
    { name: '单斜线', prefix: 'https:/', origin: 'https://login.example.test' },
    { name: '单反斜线', prefix: 'https:\\', origin: 'https://login.example.test' },
    { name: '双反斜线', prefix: 'https:\\\\', origin: 'https://login.example.test' },
    { name: '斜线接反斜线', prefix: 'https:/\\', origin: 'https://login.example.test' },
    { name: '反斜线接斜线', prefix: 'https:\\/', origin: 'https://login.example.test' },
    { name: '多重混合斜线', prefix: 'https:\\/\\/', origin: 'https://login.example.test' },
    { name: '无斜线', prefix: 'https:', origin: 'https://login.example.test' },
    { name: '大小写协议', prefix: 'hTtPs:/', origin: 'https://login.example.test' },
    { name: 'HTTP 混合斜线', prefix: 'http:\\/', origin: 'http://login.example.test' },
  ])('HTTP URL 的$name规范化后 userinfo、查询和 fragment 均隐藏', ({ prefix, origin }) => {
    const entry = record();
    const source = `${prefix}NORMALIZED_USER%3Aname:NORMALIZED_PASS%40domain@login.example.test/callback?code=NORMALIZED_CODE&state=NORMALIZED_STATE#NORMALIZED_FRAGMENT`;
    const safe = `${origin}/callback?parameter=[已隐藏]&parameter=[已隐藏]`;
    entry.url = source;
    entry.projectName = `项目 ${source}`;
    entry.request.query = [];
    entry.request.body = JSON.stringify({ link: source });
    entry.response!.body = `{"link":${JSON.stringify(source)},${JSON.stringify(source)}:"ordinary-value","id":9223372036854775807,"decimal":1.2300}`;
    entry.response!.headers = [{ id: 'location', key: 'Location', value: source, enabled: true }];
    const options = {
      includeRequestBody: true, includeResponseBody: true, includeResponseHeaders: true,
      symptom: `现象 ${source}`, steps: `打开 ${source}`,
    };
    const before = JSON.stringify({ entry, options });
    const report = buildInvestigationReport(entry, options);
    for (const text of [report.preview, report.html]) {
      for (const secret of ['NORMALIZED_USER', 'NORMALIZED_PASS', 'code=', 'state=', 'NORMALIZED_CODE', 'NORMALIZED_STATE', 'NORMALIZED_FRAGMENT']) {
        expect(text).not.toContain(secret);
      }
    }
    expect(report.preview).toContain(`项目：项目 ${safe}`);
    expect(report.preview).toContain(`Location: ${safe}`);
    expect(report.preview).toContain(`打开 ${safe}`);
    const body = responseBody(report);
    expect(JSON.parse(body).link).toBe(safe);
    expect(JSON.parse(body)[safe]).toBe('ordinary-value');
    expect(body).toContain('9223372036854775807');
    expect(body).toContain('1.2300');
    expect(JSON.stringify({ entry, options })).toBe(before);
    const document = new DOMParser().parseFromString(report.html, 'text/html');
    expect([...document.querySelectorAll('section')].map(section =>
      `${section.querySelector('h2')?.textContent}\n${section.querySelector('pre')?.textContent}`).join('\n\n')).toBe(report.preview);
  });

  it.each(['https:/', 'https:\\\\', 'https:'])('无法安全解析的 %s 候选整体省略，不能把尾部当相对路径输出', prefix => {
    const entry = record();
    const source = `${prefix}INVALID_USER:INVALID_PASS@[broken/callback?code=INVALID_CODE#INVALID_FRAGMENT`;
    entry.response!.body = JSON.stringify({ link: source });
    entry.response!.headers = [{ id: 'location', key: 'Location', value: source, enabled: true }];
    const report = buildInvestigationReport(entry, {
      includeResponseBody: true, includeResponseHeaders: true, steps: `打开 ${source}`,
    });
    for (const text of [report.preview, report.html]) {
      for (const secret of ['INVALID_USER', 'INVALID_PASS', 'INVALID_CODE', 'INVALID_FRAGMENT']) expect(text).not.toContain(secret);
    }
    expect(JSON.parse(responseBody(report)).link).toBe('[地址已省略]');
    expect(report.preview).toContain('Location: [地址已省略]');
    expect(report.preview).toContain('打开 [地址已省略]');
  });

  it('URL 扫描保留普通文本、未携带凭据的相对路径及精确数字', () => {
    const entry = record();
    entry.request.query = [];
    const plain = '正常说明 A/B；协议 HTTP 与 HTTPS；build:ready；版本 v1.2；路径 ./notes、../notes、/notes。';
    entry.response!.body = `{"plain":${JSON.stringify(plain)},"id":9223372036854775807,"decimal":1.2300,"exponent":1e400}`;
    const report = buildInvestigationReport(entry, { includeResponseBody: true, symptom: plain, steps: plain });
    const body = responseBody(report);
    expect(JSON.parse(body).plain).toBe(plain);
    expect(report.preview).toContain(`问题现象\n${plain}`);
    expect(report.preview).toContain(`复现步骤\n${plain}`);
    for (const token of ['9223372036854775807', '1.2300', '1e400']) expect(body).toContain(token);
  });

  it('不能安全解析的新 URL 整体省略，不回退输出原查询文本', () => {
    const entry = record();
    entry.response!.body = JSON.stringify({ link: 'https://[invalid-host/callback?code=MALFORMED_CODE#malformed-fragment' });
    const report = buildInvestigationReport(entry, { includeResponseBody: true });
    expect(report.preview).not.toContain('MALFORMED_CODE');
    expect(report.html).not.toContain('malformed-fragment');
    expect(JSON.parse(responseBody(report)).link).toContain('省略');
  });

  it.each([
    {
      secret: '7788992233', echoes: ['7788992233', '7788992233.0', '7.788992233e9', '778899223300e-2'],
      ordinary: ['7788992234', '9223372036854775807', '1.2300', '1e400'],
    },
    {
      secret: '9223372036854775807', echoes: ['9223372036854775807', '9.223372036854775807e18'],
      ordinary: ['9223372036854775808', '1.234567890123456789'],
    },
    {
      secret: '-0.0012300', echoes: ['-0.00123', '-123e-5', '-1.2300E-3'],
      ordinary: ['0.00123', '-0.001230000000000000001', '2e-400'],
    },
    {
      secret: '-0', echoes: ['0', '0.000', '-0e99999999999999999999999'],
      ordinary: ['1', '-1', '1.2300'],
    },
    {
      secret: '1e99999999999999999999', echoes: ['1e99999999999999999999', '10e99999999999999999998'],
      ordinary: ['1e100000000000000000000', '1e-99999999999999999999'],
    },
  ])('数字秘密 $secret 的等价回显隐藏，其他精确数字保留原文', ({ secret, echoes, ordinary }) => {
    const entry = record();
    entry.temporaryVariables = [{ id: 'api-key', key: 'apiKey', value: secret, enabled: true }];
    entry.response!.body = `{"data":[${echoes.join(',')}],"ordinary":[${ordinary.join(',')}]}`;
    const report = buildInvestigationReport(entry, { includeResponseBody: true });
    const body = responseBody(report);
    expect(JSON.parse(body).data).toEqual(echoes.map(() => '[已隐藏]'));
    for (const token of ordinary) expect(body).toContain(token);
  });

  it('数字秘密在 JSON 字符串、Header、说明中的等价写法同样隐藏', () => {
    const entry = record();
    entry.temporaryVariables = [{ id: 'api-key', key: 'apiKey', value: '7788992233', enabled: true }];
    entry.response!.body = '{"data":"7.788992233e9","ordinary":"9223372036854775807"}';
    entry.response!.headers = [{ id: 'echo', key: 'X-Echo', value: '778899223300e-2', enabled: true }];
    const report = buildInvestigationReport(entry, {
      includeResponseBody: true, includeResponseHeaders: true, symptom: '回显 7.788992233e9', steps: '核对 7788992233.000',
    });
    for (const text of [report.preview, report.html]) {
      for (const token of ['7788992233', '7.788992233e9', '778899223300e-2']) expect(text).not.toContain(token);
    }
    expect(JSON.parse(responseBody(report))).toEqual({ data: '[已隐藏]', ordinary: '9223372036854775807' });
  });

  it.each(['count', 'characters', 'numeric-token'] as const)('脱敏 %s 预算无法满足时数字节点不能绕过省略', budget => {
    const entry = record();
    entry.temporaryVariables = [{ id: 'api-key', key: 'apiKey', value: '7788992233', enabled: true }];
    if (budget === 'count') {
      entry.temporaryVariables.push(...Array.from({ length: 128 }, (_, i) => ({ id: `v${i}`, key: `v${i}`, value: `private-value-${i}`, enabled: true })));
    } else {
      entry.temporaryVariables.push({ id: 'oversized', key: 'apiKey', value: budget === 'characters' ? 'x'.repeat(20_001) : '1' + '0'.repeat(4096), enabled: true });
    }
    entry.response!.body = '[7788992233,7.788992233e9,1e4096]';
    const report = buildInvestigationReport(entry, { includeResponseBody: true });
    for (const text of [report.preview, report.html]) {
      for (const token of ['7788992233', '7.788992233e9', '1e4096']) expect(text).not.toContain(token);
    }
    expect(responseBody(report)).toContain('省略');
  });

  it('上传路径及斜线等价形式在正文、字段名、Header、步骤回显时统一隐藏', () => {
    const entry = record();
    const windowsPath = 'C:\\Users\\private-user\\finance\\payroll-2026.csv';
    const slashPath = 'C:/Users/private-user/finance/payroll-2026.csv';
    const unixPath = '/home/private-user/finance/budget-2026.csv';
    entry.request.bodyType = 'multipart';
    entry.request.form = [
      { id: 'file', key: 'upload', kind: 'file', enabled: true, value: windowsPath },
      { id: 'other-file', key: 'disabled', kind: 'file', enabled: false, value: unixPath },
    ];
    entry.response!.body = JSON.stringify({ filePath: windowsPath, slashPath, [windowsPath]: 'ordinary-value', files: [unixPath] });
    entry.response!.headers = [{ id: 'file-echo', key: 'X-File', value: `${windowsPath} ${unixPath}`, enabled: true }];
    const report = buildInvestigationReport(entry, {
      includeRequestBody: true, includeResponseBody: true, includeResponseHeaders: true,
      symptom: `上传 ${windowsPath}`, steps: `选择 ${slashPath} 或 ${unixPath}`,
    });
    for (const text of [report.preview, report.html]) {
      for (const token of ['private-user', 'payroll-2026.csv', 'budget-2026.csv', windowsPath, slashPath, unixPath]) expect(text).not.toContain(token);
    }
    expect(report.preview).toContain('文件需重新选择');
    expect(responseBody(report)).toContain('ordinary-value');
  });

  it('脱敏不修改输入记录与选项，普通数字和 JSON 输入限制保持不变', () => {
    const entry = record();
    const options = { includeResponseBody: true, steps: '本地复现' };
    entry.request.query = [];
    entry.response!.body = '{"2":9223372036854775807,"1":1.2300,"small":1e-400}';
    const before = JSON.stringify({ entry, options });
    const report = buildInvestigationReport(entry, options);
    expect(responseBody(report)).toBe('{\n  "2": 9223372036854775807,\n  "1": 1.2300,\n  "small": 1e-400\n}');
    expect(JSON.stringify({ entry, options })).toBe(before);
  });
});
