import { describe, expect, it, vi } from 'vitest';
import type { RequestConfig, Workspace } from '../types';
import { importCurl } from './curl';
import { resolveRequest } from './environment';
import { demoWorkspace, emptyWorkspace, newRequest } from './workspace';

const effectiveImportedRequest = (w: Workspace) => resolveRequest(
  w.requests.at(-1)!, w.projects.find(p => p.id === w.activeProjectId)!.activeEnvironmentId,
);
const executionConfig = (r: RequestConfig): RequestConfig => ({
  query: r.query, headers: r.headers, auth: r.auth,
  bodyType: r.bodyType, body: r.body, form: r.form, timeoutMs: r.timeoutMs,
});
const allIds = (w: Workspace) => [
  ...w.projects, ...w.environments, ...w.services, ...w.bindings, ...w.folders, ...w.requests, ...w.variables,
  ...w.services.flatMap(s => s.headers ?? []),
  ...w.requests.flatMap(r => [r, ...Object.values(r.environmentConfigs ?? {})]
    .flatMap(c => [...c.query, ...c.headers, ...(c.form ?? [])])),
].map(e => e.id);

describe('安全的 POSIX cURL 纯解析', () => {
  it.each(['demo-dev', 'demo-prod'])('在 %s 导入的正文/Query/Header/鉴权/超时不进入共享缺省或其他环境，绑定保持隔离', environmentId => {
    const w = demoWorkspace();
    w.projects[0].activeEnvironmentId = environmentId;
    const otherEnvironmentId = w.environments.find(e => e.id !== environmentId)!.id;
    const before = structuredClone(w);
    const next = importCurl(w, `curl 'https://import.example.com:8443/a?x=1&token=query-secret' --json '{"only":"A"}' -H 'X-Env: A' -H 'Cookie: cookie-secret' -u user:pass --max-time 1.234`);
    const stored = next.requests.at(-1)!;
    const effective = resolveRequest(stored, environmentId);
    const defaults = executionConfig(newRequest(stored.serviceId, null, stored.id));
    expect(executionConfig(resolveRequest(stored, otherEnvironmentId))).toEqual(defaults);
    expect(executionConfig(stored)).toEqual(defaults);
    expect(Object.keys(stored.environmentConfigs!)).toEqual([environmentId]);
    expect(effective).toMatchObject({ name: 'cURL 导入', method: 'POST', path: '/a', body: '{"only":"A"}', bodyType: 'json', timeoutMs: 1234 });
    expect(effective.query.map(p => p.key)).toEqual(['x', 'token']);
    expect(effective.headers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'X-Env', value: 'A' }),
      expect.objectContaining({ key: 'Cookie', value: expect.stringMatching(/^\{\{curl_secret_\d+\}\}$/) }),
    ]));
    expect(effective.auth).toMatchObject({ kind: 'basic', username: expect.stringMatching(/^\{\{/), password: expect.stringMatching(/^\{\{/) });
    expect(JSON.stringify(stored)).not.toMatch(/query-secret|cookie-secret/);
    expect(next.variables.every(v => v.scope === 'request' && v.ownerId === stored.id && v.isSecret)).toBe(true);
    expect(next.bindings.slice(0, -1)).toEqual(before.bindings);
    expect(next.bindings.filter(b => b.serviceId === stored.serviceId)).toEqual([
      expect.objectContaining({ environmentId, baseUrl: 'https://import.example.com:8443', enabled: true }),
    ]);
    expect(resolveRequest(stored, otherEnvironmentId)).toMatchObject({ name: 'cURL 导入', method: 'POST', path: '/a' });
    expect(next.requests.slice(0, -1)).toEqual(before.requests);
    expect(w).toEqual(before);
  });

  it('multipart 文本/文件占位符仅存在当前环境，不成为其他环境的模板', () => {
    const next = importCurl(demoWorkspace(), `curl https://example.com/upload -F 'tag=A' -F 'password=secret' -F 'file=@private.txt'`);
    const stored = next.requests.at(-1)!;
    expect(resolveRequest(stored, 'demo-prod').form).toBeUndefined();
    expect(stored.form).toBeUndefined();
    expect(stored.bodyType).toBe('none');
    expect(resolveRequest(stored, 'demo-dev')).toMatchObject({
      bodyType: 'multipart',
      form: [
        { key: 'tag', value: 'A', kind: 'text', enabled: true },
        { key: 'password', value: expect.stringMatching(/^\{\{curl_secret_\d+\}\}$/), kind: 'text', enabled: true },
        { key: 'file', value: '', kind: 'file', enabled: false },
      ],
    });
    expect(next.bindings.at(-1)).toMatchObject({ environmentId: 'demo-dev', baseUrl: 'https://example.com' });
  });

  it('ID 分配覆盖所有环境的 Query/Header/Form，避免与非活动环境模板碰撞', () => {
    const w = demoWorkspace();
    const occupied = [
      'occupied-query-0000-0000-000000000000',
      'occupied-header-0000-0000-000000000000',
      'occupied-form-0000-0000-000000000000',
    ] as const;
    w.requests[1].environmentConfigs = {
      'demo-prod': {
        query: [{ id: occupied[0], key: 'x', value: '1', enabled: true }],
        headers: [{ id: occupied[1], key: 'X-Test', value: '1', enabled: true }],
        form: [{ id: occupied[2], key: 'f', value: '1', enabled: true, kind: 'text' }],
        body: '', bodyType: 'multipart', timeoutMs: 30000,
      },
    };
    const before = structuredClone(w);
    let sequence = 0;
    const uuid = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(occupied[0]).mockReturnValueOnce(occupied[1]).mockReturnValueOnce(occupied[2])
      .mockImplementation(() => `fresh-0000-0000-0000-${++sequence}`);
    try {
      const next = importCurl(w, `curl 'https://example.com?x=1' -H 'X-Test: 1' -u user:pass -F text=value`);
      expect(new Set(allIds(next)).size).toBe(allIds(next).length);
      expect(next.services.at(-1)?.id).toMatch(/^fresh-/);
      expect(w).toEqual(before);
    } finally { uuid.mockRestore(); }
  });

  it('在活动项目/环境创建新服务和 origin 绑定，保留路径、端口、重复 Query/Header', () => {
    const w = demoWorkspace();
    w.revision = 42;
    const before = structuredClone(w);
    const next = importCurl(w, `curl 'https://example.com:8443/v1/a%2Fb//c/?x=1&x=2&q=a%2Bb&q=a+b&empty=' -H 'X-Test: first' -H 'X-Test: second'`, '导入服务');
    const service = next.services.at(-1)!;
    const request = effectiveImportedRequest(next);
    expect(service).toMatchObject({ name: '导入服务', projectId: w.activeProjectId });
    expect(next.bindings.at(-1)).toMatchObject({ serviceId: service.id, projectId: w.activeProjectId, environmentId: w.projects[0].activeEnvironmentId, baseUrl: 'https://example.com:8443', enabled: true });
    expect(request).toMatchObject({ serviceId: service.id, folderId: null, method: 'GET', path: '/v1/a%2Fb//c/' });
    expect(request.query.map(p => [p.key, p.value])).toEqual([['x', '1'], ['x', '2'], ['q', 'a+b'], ['q', 'a b'], ['empty', '']]);
    expect(request.headers.map(p => [p.key, p.value])).toEqual([['X-Test', 'first'], ['X-Test', 'second']]);
    expect(next.bindings.slice(0, -1)).toEqual(w.bindings);
    expect(next.activeProjectId).toBe(w.activeProjectId);
    expect(next.projects).toEqual(w.projects);
    expect(next.revision).toBe(42);
    expect(w).toEqual(before);
  });

  it('正确处理 POSIX 拼接引号、双引号转义和 LF/CRLF 续行', () => {
    const next = importCurl(demoWorkspace(), "curl \\\r\n --url 'https://example.com:443/a' \\\n -XPOST -H 'X-Name: it'\\''s' --data-raw \"a=\\\"b\\\"&path=\\q\"");
    const r = effectiveImportedRequest(next);
    expect(next.bindings.at(-1)?.baseUrl).toBe('https://example.com:443');
    expect(r.method).toBe('POST');
    expect(r.headers[0].value).toBe("it's");
    expect(r.body).toBe('a="b"&path=\\q');
  });

  it('data 参数以 & 拼接，显式方法优先；raw @ 只是正文', () => {
    const next = importCurl(demoWorkspace(), `curl --request PATCH --data a=1 -d 'b=2' --data-raw '@not-a-file' https://example.com`);
    const r = effectiveImportedRequest(next);
    expect(r).toMatchObject({ method: 'PATCH', body: 'a=1&b=2&@not-a-file', bodyType: 'text' });
    expect(r.headers).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })]));
  });

  it('json 拼接且增加默认 Content-Type/Accept，不覆盖手动头', () => {
    const next = importCurl(demoWorkspace(), `curl --json '{"a":' --json '1}' -H 'Accept: custom/type' https://example.com`);
    const r = effectiveImportedRequest(next);
    expect(r).toMatchObject({ method: 'POST', bodyType: 'json', body: '{"a":1}' });
    expect(r.headers.filter(p => p.key.toLowerCase() === 'accept').map(p => p.value)).toEqual(['custom/type']);
    expect(r.headers.find(p => p.key === 'Content-Type')?.value).toBe('application/json');
  });

  it('basic 鉴权和敏感 Header/Query/Cookie 存储为新秘密变量，原变量不变', () => {
    const w = demoWorkspace();
    w.variables.push({ id: 'v', projectId: w.projects[0].id, scope: 'project', ownerId: w.projects[0].id, name: 'curl_secret_1', value: 'old', isSecret: false });
    const next = importCurl(w, `curl -u 'alice:p:a:ss' -H 'X-API-Key: api-secret' -H 'Cookie: session=cookie-secret' 'https://example.com/a?access_token=query-secret'`);
    const r = effectiveImportedRequest(next);
    expect(r.auth?.kind).toBe('basic');
    expect(r.auth?.username).toMatch(/^\{\{.+\}\}$/);
    expect(r.auth?.password).toMatch(/^\{\{.+\}\}$/);
    expect(next.variables.slice(1).every(v => v.isSecret && v.ownerId === r.id && v.scope === 'request')).toBe(true);
    expect(next.variables.slice(1).map(v => v.value)).toEqual(expect.arrayContaining(['alice', 'p:a:ss', 'api-secret', 'session=cookie-secret', 'query-secret']));
    expect(JSON.stringify(r)).not.toMatch(/p:a:ss|api-secret|cookie-secret|query-secret/);
    expect(next.variables[0]).toEqual(w.variables[0]);
    expect(new Set(next.variables.map(v => v.name)).size).toBe(next.variables.length);
  });

  it('Authorization 字面量包括已有模板样式仍隔离为变量，不绑定到现有秘密', () => {
    const next = importCurl(demoWorkspace(), `curl -H 'Authorization: Bearer {{not_a_workspace_variable}}' https://example.com`);
    const r = effectiveImportedRequest(next);
    expect(r.headers[0].value).toMatch(/^\{\{.+\}\}$/);
    expect(next.variables.at(-1)?.value).toBe('Bearer {{not_a_workspace_variable}}');
  });

  it('基础 multipart 保留重复文本项，清空并禁用文件项，不读取文件', () => {
    const next = importCurl(demoWorkspace(), `curl -F 'tag=one' -F 'tag=two' -F 'upload=@C:\\private\\secret.txt' -F 'part=<C:\\private\\body.txt' https://example.com/upload`);
    const r = effectiveImportedRequest(next);
    expect(r).toMatchObject({ method: 'POST', bodyType: 'multipart', body: '' });
    expect(r.form?.map(f => [f.key, f.value, f.kind, f.enabled])).toEqual([
      ['tag', 'one', 'text', true], ['tag', 'two', 'text', true],
      ['upload', '', 'file', false], ['part', '', 'file', false],
    ]);
    expect(JSON.stringify(next)).not.toContain('private');
  });

  it('支持 IPv6、长选项等号和短选项紧贴值，Query 值保留等号/百分号/中文', () => {
    const next = importCurl(demoWorkspace(), `curl --url='http://[::1]:8080/a%2fb/?q=a%3Db&percent=%252F&name=%E4%B8%AD%E6%96%87' -XPUT -H'X-A: v' --data-raw=''`);
    expect(next.bindings.at(-1)?.baseUrl).toBe('http://[::1]:8080');
    const r = effectiveImportedRequest(next);
    expect(r.path).toBe('/a%2fb/');
    expect(r.query.map(p => p.value)).toEqual(['a=b', '%2F', '中文']);
    expect(r).toMatchObject({ method: 'PUT', body: '', bodyType: 'text' });
  });

  it('单引号内普通 $ 和执行运算符只是正文，转义美元符号不作环境展开', () => {
    const next = importCurl(demoWorkspace(), `curl https://example.com --data-raw 'price=$5; literal | & > <' -H "X-Price: \\$5"`);
    expect(effectiveImportedRequest(next).body).toBe('price=$5; literal | & > <');
    expect(effectiveImportedRequest(next).headers[0].value).toBe('$5');
  });

  it('导入 ID 全局唯一，服务/环境/接口和全部 Pair/Form/变量不发生碰撞', () => {
    const next = importCurl(demoWorkspace(), `curl -u u:p -F a=x -F token=private https://example.com`);
    const ids = allIds(next);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('重导入引擎输出：安全传输选项、毫秒超时和 Content-Type 默认值抑制', () => {
    const next = importCurl(demoWorkspace(), `curl --http1.1 --globoff --path-as-is --max-time '30.000' --request 'POST' --url 'https://example.com:443/v1/a%2Fb?q=one&q=two' --header 'Content-Type:' --header 'X-Empty;' --data-raw 'hello'`);
    const r = effectiveImportedRequest(next);
    expect(r).toMatchObject({ method: 'POST', timeoutMs: 30000, bodyType: 'text', body: 'hello', path: '/v1/a%2Fb' });
    expect(r.headers.map(p => [p.key, p.value])).toEqual([['X-Empty', '']]);
    expect(r.query.map(p => p.value)).toEqual(['one', 'two']);
    expect(next.bindings.at(-1)?.baseUrl).toBe('https://example.com:443');
  });

  it('重导入引擎 HEAD 导出格式，保留地址、重复 Query/Header 和超时', () => {
    const w = demoWorkspace();
    const before = structuredClone(w);
    const next = importCurl(w, `curl --http1.1 --globoff --path-as-is --max-time '1.001' --head --url 'https://example.com:443/v1/a%2Fb?q=one&q=two' --header 'X-Test: first' --header 'X-Test: second' --header 'X-Empty;'`);
    const r = effectiveImportedRequest(next);
    expect(r).toMatchObject({ method: 'HEAD', bodyType: 'none', body: '', timeoutMs: 1001, path: '/v1/a%2Fb' });
    expect(r.form).toBeUndefined();
    expect(r.query.map(p => [p.key, p.value])).toEqual([['q', 'one'], ['q', 'two']]);
    expect(r.headers.map(p => [p.key, p.value])).toEqual([['X-Test', 'first'], ['X-Test', 'second'], ['X-Empty', '']]);
    expect(next.bindings.at(-1)?.baseUrl).toBe('https://example.com:443');
    expect(next.bindings.slice(0, -1)).toEqual(w.bindings);
    expect(next.revision).toBe(w.revision);
    expect(w).toEqual(before);
  });

  it.each(['--head', '-I', '-I --head', '--head -X HEAD', '--request HEAD -I', '-X HEAD'])('HEAD 无冲突写法：%s', flags => {
    expect(effectiveImportedRequest(importCurl(demoWorkspace(), `curl ${flags} https://example.com`)))
      .toMatchObject({ method: 'HEAD', bodyType: 'none', body: '' });
  });

  it.each([
    '--head -X GET', '-X POST -I', '--head -X GET -X HEAD', '-X HEAD -I -X GET',
    '-I --data x=1', '--data x=1 --head', '--head --data-raw ""',
    '--json "{}" -I', '-I -F field=value', '--form-string field=value --head',
  ])('HEAD 冲突不因顺序或后续覆盖而被静默接受：%s', flags => {
    const w = demoWorkspace();
    const before = structuredClone(w);
    expect(() => importCurl(w, `curl ${flags} https://example.com`)).toThrow(/HEAD.*冲突/);
    expect(w).toEqual(before);
  });

  it.each(['--head=true', '--head=false', '-Ivalue', '--no-head', '-Ik'])('HEAD 开关不接受附加值或未支持组合：%s', flags => {
    expect(() => importCurl(demoWorkspace(), `curl ${flags} https://example.com`)).toThrow(/不支持/);
  });

  it('form-string 按字面值导入；原生 form 文件占位符清空禁用', () => {
    const next = importCurl(demoWorkspace(), `curl --http1.1 --globoff --path-as-is --max-time=0.001 --url https://example.com/upload --form-string 'field=@not-a-file;type=text/plain' --form-string 'field=<literal' --form-string 'quoted="keep"' --form 'upload=@<RESELECT_FILE>'`);
    const r = effectiveImportedRequest(next);
    expect(r.timeoutMs).toBe(1);
    expect(r.form?.map(f => [f.key, f.value, f.kind, f.enabled])).toEqual([
      ['field', '@not-a-file;type=text/plain', 'text', true],
      ['field', '<literal', 'text', true], ['quoted', '"keep"', 'text', true],
      ['upload', '', 'file', false],
    ]);
  });

  it.each([['.5', 500], ['300', 300000], ['1.234', 1234], ['0001.2300', 1230]])('转换 max-time %s 为 %s ms', (value, timeout) => {
    expect(effectiveImportedRequest(importCurl(demoWorkspace(), `curl --max-time ${value} https://example.com`)).timeoutMs).toBe(timeout);
  });

  it('显式空 Content-Type 使用分号保留，而冒号抑制 json 默认头', () => {
    const explicit = effectiveImportedRequest(importCurl(demoWorkspace(), "curl https://example.com -H 'Content-Type;' --data-raw hello"));
    expect(explicit.headers.map(p => [p.key, p.value])).toEqual([['Content-Type', '']]);
    const suppressed = effectiveImportedRequest(importCurl(demoWorkspace(), "curl https://example.com -H 'content-type:' --json '{}'"));
    // text avoids the native JSON engine reintroducing its own Content-Type.
    expect(suppressed.bodyType).toBe('text');
    expect(suppressed.headers.map(p => [p.key, p.value])).toEqual([['Accept', 'application/json']]);
  });

  it.each([
    'curl --max-time 0 https://example.com',
    'curl --max-time 300.001 https://example.com',
    'curl --max-time 0.0001 https://example.com',
    'curl --max-time -1 https://example.com',
    'curl --max-time Infinity https://example.com',
    'curl --max-time 1e2 https://example.com',
    'curl --http1.1=secret https://example.com',
    'curl --globoff=yes https://example.com',
    'curl --path-as-is=yes https://example.com',
    'curl --max-time https://example.com',
    'curl --form-string missing https://example.com',
    'curl --form-string a=b --data c=d https://example.com',
    'curl --insecure https://example.com',
    'curl --proxy http://proxy.example.com https://example.com',
    'curl --http2 https://example.com',
  ])('新增白名单选项不放宽危险语法或超时边界：%s', command => {
    expect(() => importCurl(demoWorkspace(), command)).toThrow(/[\u4e00-\u9fff]/);
  });

  it.each([
    "curl 'https://example.com?'",
    "curl 'https://example.com?flag'",
    "curl 'https://example.com?a=1&&b=2'",
    "curl 'https://example.com?a=1&'",
    "curl 'https://example.com?q={one,two}'",
    "curl 'https://example.com?q=[1-2]'",
    "curl 'https://example.com//authority-path'",
    "curl https://example.com -H 'Host: other.example.com'",
    "curl https://example.com -H 'Content-Length: 42'",
    "curl https://example.com -H 'Transfer-Encoding: chunked'",
    "curl https://example.com -F 'a=\"quoted\"'",
    "curl https://example.com -F 'a=(nested'",
    "curl https://example.com -F 'a=x' -H 'Content-Type: multipart/form-data'",
    "curl https://example.com -u 'user:password\nnext'",
    "curl https://example.com --data-raw '{{existing_workspace_variable}}'",
    "curl 'https://example.com?q=%7B%7Bexisting%7D%7D'",
  ])('不静默接受会被执行引擎改变语义的输入：%s', command => {
    expect(() => importCurl(demoWorkspace(), command)).toThrow(/[\u4e00-\u9fff]/);
  });

  it.each([
    'curl https://example.com | cat',
    'curl https://example.com && echo pwn',
    'curl https://example.com; echo pwn',
    'curl https://example.com > file',
    'curl https://example.com < file',
    'curl https://example.com &',
    'curl https://example.com\nwhoami',
    'curl "https://example.com/$(whoami)"',
    "curl 'https://example.com/`whoami`'",
    'curl https://example.com/$HOME',
    'curl $\'https://example.com\'',
    'curl https://example.com # comment',
    'curl https://example.com -k',
    'curl https://example.com --location',
    'curl https://example.com --config private-secret',
    'curl https://example.com -H @headers.txt',
    'curl https://example.com --data @body.txt',
    'curl https://example.com --json @body.json',
    'curl https://example.com -u user',
    'curl https://example.com -u u:p -H "Authorization: secret"',
    'curl https://example.com -H "X-A:"',
    'curl https://example.com -H "bad header: value"',
    'curl https://example.com -H "X-A: one\ntwo"',
    'curl https://example.com -d a --json "{}"',
    'curl https://example.com -d a -F b=c',
    'curl https://example.com -F "f=@file;type=text/plain"',
    'curl https://example.com -F "f=@a,b"',
    'curl https://example.com https://other.example.com',
    'curl ftp://example.com',
    'curl https://user:password@example.com',
    'curl https://example.com/a/../b',
    'curl https://example.com/%2e%2e/b',
    'curl https://example.com/a%5Cb',
    'curl https://example.com/a#fragment',
    'curl "https://example.com?q=%FF"',
    'curl https://example.com -X',
    'curl "https://example.com',
    'wget https://example.com',
  ])('明确拒绝不支持或危险语法：%s', command => {
    const w = demoWorkspace();
    const before = structuredClone(w);
    expect(() => importCurl(w, command)).toThrow(/[\u4e00-\u9fff]/);
    try { importCurl(w, command); } catch (e) { expect(String(e)).not.toContain('private-secret'); }
    expect(w).toEqual(before);
  });

  it('拒绝不存在的活动项目/环境和超大输入', () => {
    expect(() => importCurl(emptyWorkspace(), 'curl https://example.com')).toThrow(/项目/);
    const w = demoWorkspace();
    w.projects[0].activeEnvironmentId = null;
    expect(() => importCurl(w, 'curl https://example.com')).toThrow(/环境/);
    expect(() => importCurl(demoWorkspace(), 'curl ' + 'a'.repeat(1024 * 1024 + 1))).toThrow(/大小|上限/);
  });
});
