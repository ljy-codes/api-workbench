import { describe, expect, it } from 'vitest';
import { applyOpenApiPreview, parseOpenApi, previewOpenApi } from './openapi';
import { demoWorkspace, emptyWorkspace } from './workspace';

const source = (paths: unknown, extra = {}) => JSON.stringify({
  openapi: '3.1.0', info: { title: '宠物 API', version: '1' }, paths, ...extra,
});
const operation = (extra = {}) => ({ summary: '文档名称', responses: { 200: { description: 'ok' } }, ...extra });
const target = { projectId: 'demo-project', serviceId: 'demo-users' };

describe('OpenAPI 离线解析边界', () => {
  it.each(['3.0.3', '3.1.0'])('解析 %s 的目录、路径变量、覆盖参数、本地引用与基本正文样例', version => {
    const parsed = parseOpenApi(source({
      '/pets/{id}': {
        parameters: [{ in: 'query', name: 'page', schema: { default: 1 } }],
        post: operation({
          tags: ['宠物'], parameters: [
            { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
            { in: 'query', name: 'page', schema: { type: 'integer', default: 2 } },
            { $ref: '#/components/parameters/Trace' },
          ],
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        }),
      },
    }, { openapi: version, servers: [{ url: 'https://example.com/v1' }], components: {
      parameters: { Trace: { in: 'header', name: 'X-Trace', schema: { type: 'string', default: 'trace' } } },
      schemas: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'cat' }, age: { type: 'integer' } } } },
    } }));
    const w = parsed.bundle.workspace, r = w.requests[0];
    expect(r).toMatchObject({ method: 'POST', path: '/pets/{{id}}', bodyType: 'json' });
    expect(JSON.parse(r.body)).toEqual({ name: 'cat', age: 0 });
    expect(r.query.map(p => [p.key, p.value])).toEqual([['page', '2']]);
    expect(r.headers[0]).toMatchObject({ key: 'X-Trace', value: 'trace' });
    expect(w.folders[0].name).toBe('宠物');
    expect(w.variables[0]).toMatchObject({ scope: 'request', name: 'id', value: '' });
    expect(w.bindings[0].baseUrl).toBe('https://example.com/v1');
  });

  it('解析 Swagger 2 YAML、basePath 和 body 参数', () => {
    const parsed = parseOpenApi(`swagger: '2.0'
info: { title: Legacy, version: '1' }
host: example.com
schemes: [https]
basePath: /v2
paths:
  /pets:
    post:
      parameters:
        - in: body
          name: payload
          schema: { type: object, properties: { active: { type: boolean } } }
      responses: { '200': { description: ok } }
`);
    expect(parsed.bundle.workspace.bindings[0].baseUrl).toBe('https://example.com/v2');
    expect(JSON.parse(parsed.bundle.workspace.requests[0].body)).toEqual({ active: false });
  });

  it.each([
    '{"openapi":"3.1.0","openapi":"3.0.3","info":{"title":"a","version":"1"},"paths":{}}',
    '{"openapi":"9","info":{"title":"a","version":"1"},"paths":{}}',
    'a: &x { b: c }\npaths: *x',
    '!!js/function function() {}',
    '{"__proto__":{"polluted":true}}',
    source({ '/pets': { get: operation({ parameters: 'wrong' }) } }),
    source({ '/pets': { get: operation({ parameters: [{ name: 'a', in: 'query' }, { name: 'a', in: 'query' }] }) } }),
    source({ '/pets/{id}': { get: operation() } }),
  ])('拒绝非法或不安全输入且不产生可应用预览：%s', text => {
    expect(() => parseOpenApi(text)).toThrow();
  });

  it('限制文本大小、结构嵌套和引用展开预算', () => {
    expect(() => parseOpenApi(' '.repeat(10 * 1024 * 1024 + 1))).toThrow(/10 MiB/);
    expect(() => parseOpenApi('['.repeat(40) + '0' + ']'.repeat(40))).toThrow();
    const schemas: Record<string, unknown> = { S0: { type: 'string' } };
    for (let i = 1; i < 24; i++) schemas[`S${i}`] = { $ref: `#/components/schemas/S${i - 1}` };
    const parsed = parseOpenApi(source({ '/pets': { post: operation({
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S23' } } } },
    }) } }, { components: { schemas } }));
    expect(previewOpenApi(emptyWorkspace(), parsed).rows[0].kind).toBe('blocked');
    expect(parsed.bundle.warnings.join()).toMatch(/预算|深度/);
  });

  it.each([
    { $ref: 'https://example.com/schema.json' },
    { $ref: './schema.yaml' },
    { $ref: '#/components/schemas/Loop' },
    { oneOf: [{ type: 'string' }, { type: 'number' }] },
  ])('外部/循环引用与不支持的正文结构阻止该接口并明确告警', schema => {
    const parsed = parseOpenApi(source({ '/pets': { post: operation({
      requestBody: { content: { 'application/json': { schema } } },
    }) } }, { components: { schemas: { Loop: { $ref: '#/components/schemas/Loop' } } } }));
    const p = previewOpenApi(emptyWorkspace(), parsed);
    expect(p.rows[0].kind).toBe('blocked');
    expect(p.warnings.join()).toMatch(/不支持|引用|循环/);
    expect(() => applyOpenApiPreview(emptyWorkspace(), p, [p.rows[0].key])).toThrow();
  });

  it('清空已知凭据，服务器凭据和安全方案不自动填入', () => {
    const parsed = parseOpenApi(source({ '/pets': { post: operation({
      parameters: [{ in: 'header', name: 'Authorization', schema: { type: 'string' }, example: 'Bearer doc-secret' }],
      requestBody: { content: { 'application/json': { example: { password: 'hidden', nested: { apiKey: 'private', name: 'cat' } } } } },
    }) } }, { security: [{ bearer: [] }], servers: [{ url: 'https://user:password@example.com/' }] }));
    const r = parsed.bundle.workspace.requests[0];
    expect(r.headers[0]).toMatchObject({ value: '', enabled: false });
    expect(JSON.parse(r.body)).toEqual({ password: '', nested: { apiKey: '', name: 'cat' } });
    expect(parsed.bundle.workspace.bindings[0].baseUrl).toBe('');
    expect(parsed.bundle.warnings.join()).toMatch(/凭据/);
    expect(parsed.bundle.warnings.join()).toMatch(/安全|鉴权/);
  });

  it.each(['3.0.3', '3.1.0', 'swagger-2.0'])('%s 的 Query 参数名不能引入本地模板变量', version => {
    const paths = { '/users': { get: operation({ parameters: [{
      in: 'query', name: '{{token}}_echo',
      ...(version === 'swagger-2.0' ? { type: 'string', default: 'x' } : { schema: { type: 'string', default: 'x' } }),
    }] }) } };
    const parsed = parseOpenApi(version === 'swagger-2.0'
      ? JSON.stringify({ swagger: '2.0', info: { title: 'Legacy', version: '1' }, paths })
      : source(paths, { openapi: version }));
    const workspace = demoWorkspace();
    workspace.variables.push({
      id: 'private-token', projectId: 'demo-project', scope: 'environment',
      ownerId: 'demo-dev', name: 'token', value: 'SYNTHETIC_TOKEN_42b8', isSecret: true,
    });
    const before = structuredClone(workspace);
    for (const destination of [undefined, target]) {
      const preview = previewOpenApi(workspace, parsed, destination);
      expect(preview.rows[0].kind).toBe('blocked');
      expect(preview.rows[0].warnings.join()).toMatch(/模板|变量/);
      expect(() => applyOpenApiPreview(workspace, preview, [preview.rows[0].key])).toThrow();
    }
    expect(parsed.bundle.workspace.requests).toHaveLength(0);
    expect(workspace).toEqual(before);
  });

  it.each([
    { schema: { type: 'object', properties: { id: { type: 'string' } } }, example: 'looks-simple' },
    { schema: { $ref: 'file:///secret.yaml' }, example: 'looks-simple' },
  ])('参数 example 不能掩盖不支持的 schema', parameter => {
    const parsed = parseOpenApi(source({ '/pets': { get: operation({ parameters: [
      { in: 'query', name: 'filter', ...parameter },
    ] }) } }));
    expect(previewOpenApi(emptyWorkspace(), parsed).rows[0].kind).toBe('blocked');
  });

  it('正文 example 不能掩盖外部 schema 引用，OAS 特殊 header 只留禁用占位', () => {
    const parsed = parseOpenApi(source({ '/pets': {
      get: operation({ parameters: [{ in: 'header', name: 'Content-Type', schema: { type: 'string', default: 'bad/type' } }] }),
      post: operation({ requestBody: { content: { 'application/json': { schema: { $ref: './body.yaml' }, example: {} } } } }),
    } }));
    const p = previewOpenApi(emptyWorkspace(), parsed);
    expect(p.rows.find(r => r.label === 'POST /pets')!.kind).toBe('blocked');
    expect(parsed.bundle.workspace.requests[0].headers[0]).toMatchObject({ key: 'Content-Type', value: '', enabled: false });
    expect(p.warnings.join()).toMatch(/特殊|规范/);
  });

  it('Schema 自带 example 也不能隐藏嵌套外部引用', () => {
    const parsed = parseOpenApi(source({ '/pets': { post: operation({
      requestBody: { content: { 'application/json': { schema: {
        type: 'object', example: { child: 'simple' },
        properties: { child: { $ref: 'https://example.com/child.json' } },
      } } } },
    }) } }));
    expect(previewOpenApi(emptyWorkspace(), parsed).rows[0].kind).toBe('blocked');
  });

  it('Swagger 操作级 schemes 不会被静默忽略', () => {
    const parsed = parseOpenApi(JSON.stringify({
      swagger: '2.0', info: { title: 'old', version: '1' }, host: 'example.com', schemes: ['https'],
      paths: { '/pets': { get: operation({ schemes: ['http'] }) } },
    }));
    expect(previewOpenApi(emptyWorkspace(), parsed).rows[0].kind).toBe('blocked');
  });

  it.each([
    source({ '/../users': { get: operation() } }),
    source({ '/%2e%2e/users': { get: operation() } }),
    source({ '/pets/{id}': { get: operation({ parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }] }) },
      '/pets/{name}': { get: operation({ parameters: [{ in: 'path', name: 'name', required: true, schema: { type: 'string' } }] }) } }),
    source({ '/pets': { get: operation({ parameters: [{ in: 'query', name: 'q', required: 'yes', schema: { type: 'string' } }] }) } }),
    source({ '/pets': { get: operation({ parameters: [{ in: 'query', name: 'q' }] }) } }),
  ])('拒绝路径穿越、模板歧义和已识别字段的非法类型', input => {
    expect(() => parseOpenApi(input)).toThrow();
  });

  it('不接受会被 URL 构造器静默归一化的服务器点段', () => {
    const parsed = parseOpenApi(source({ '/pets': { get: operation() } }, { servers: [{ url: 'https://example.com/a/../b' }] }));
    expect(parsed.bundle.workspace.bindings[0].baseUrl).toBe('');
  });

  it('允许 additionalProperties:false 的普通对象 schema', () => {
    const parsed = parseOpenApi(source({ '/pets': { post: operation({
      requestBody: { content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, properties: { name: { type: 'string', example: 'cat' } },
      } } } },
    }) } }));
    expect(previewOpenApi(emptyWorkspace(), parsed).rows[0].kind).toBe('added');
    expect(JSON.parse(parsed.bundle.workspace.requests[0].body)).toEqual({ name: 'cat' });
  });
});

describe('OpenAPI 精确匹配与安全合并', () => {
  const doc = () => parseOpenApi(source({
    '/users': { get: operation({ tags: ['文档目录'], parameters: [
      { in: 'query', name: 'page', schema: { default: 9 } },
      { in: 'query', name: 'limit', schema: { default: 20 } },
      { in: 'header', name: 'X-New', schema: { default: 'ok' } },
    ] }) },
    '/new': { post: operation() },
  }));

  it('预览列新增、变化、文档未列出和本地命名冲突，确认前不变更', () => {
    const w = demoWorkspace(), original = structuredClone(w);
    const preview = previewOpenApi(w, doc(), target);
    expect(preview.rows.map(r => r.kind)).toEqual(['changed', 'added', 'removed']);
    expect(preview.rows[0].updates.join()).toMatch(/limit/);
    expect(preview.rows[0].warnings.join()).toMatch(/名称|命名/);
    expect(w).toEqual(original);
  });

  it('只勾选变化项：保留值/启用状态/auth/body/env/超时/变量/绑定/名称/目录并只补新字段', () => {
    const w = demoWorkspace(), r = w.requests[0];
    r.query[0].enabled = false;
    r.query.push({ id: 'legacy', key: 'legacy', value: 'keep', enabled: true });
    r.headers = [{ id: 'token', key: 'Authorization', value: '{{token}}', enabled: false }];
    r.auth = { kind: 'bearer', token: '{{token}}' };
    r.bodyType = 'json'; r.body = '{"test":true}'; r.timeoutMs = 54321;
    r.environmentConfigs = { 'demo-prod': {
      query: [{ id: 'prod-q', key: 'page', value: '888', enabled: false }],
      headers: [], auth: { kind: 'basic', password: '{{prod}}' },
      bodyType: 'text', body: 'production-test', timeoutMs: 1234,
    } };
    const original = structuredClone(w), p = previewOpenApi(w, doc(), target);
    const next = applyOpenApiPreview(w, p, [p.rows[0].key]);
    expect(next.requests[0]).toEqual({
      ...original.requests[0],
      query: [...original.requests[0].query, expect.objectContaining({ key: 'limit', value: '20', enabled: true })],
      headers: [...original.requests[0].headers, expect.objectContaining({ key: 'X-New', value: 'ok' })],
    });
    expect(next.requests[0].environmentConfigs).toEqual(original.requests[0].environmentConfigs);
    expect(next.bindings).toEqual(original.bindings);
    expect(next.variables).toEqual(original.variables);
    expect(next.requests).toHaveLength(2);
    expect(p.rows[0].warnings.join()).toMatch(/legacy/);
    expect(w).toEqual(original);
  });

  it('Header 大小写等价，Query 大小写有别，重复本地参数保留且提示', () => {
    const w = demoWorkspace();
    w.requests[0].headers = [{ id: 'h', key: 'x-new', value: 'local', enabled: false }];
    w.requests[0].query.push({ id: 'q2', key: 'page', value: 'second', enabled: true });
    const p = previewOpenApi(w, doc(), target), next = applyOpenApiPreview(w, p, [p.rows[0].key]);
    expect(next.requests[0].headers).toEqual(w.requests[0].headers);
    expect(next.requests[0].query.filter(q => q.key === 'page')).toHaveLength(2);
    expect(p.rows[0].warnings.join()).toMatch(/重复/);
  });

  it('相同 method/path 多个本地请求阻止该项；移除提示不可勾选，均不删除', () => {
    const w = demoWorkspace();
    w.requests.push({ ...structuredClone(w.requests[0]), id: 'duplicate', query: [] });
    const p = previewOpenApi(w, doc(), target);
    expect(p.rows[0].kind).toBe('blocked');
    expect(() => applyOpenApiPreview(w, p, [p.rows[0].key])).toThrow(/歧义|阻止/);
    expect(() => applyOpenApiPreview(w, p, [p.rows.find(r => r.kind === 'removed')!.key])).toThrow();
    expect(w.requests).toHaveLength(3);
  });

  it.each(['request', 'service', 'environment', 'revision'])('预览后 %s 改变即整体拒绝，不能覆盖过期数据', field => {
    const w = demoWorkspace(), p = previewOpenApi(w, doc(), target), changed = structuredClone(w);
    if (field === 'request') changed.requests[0].body = 'new draft';
    if (field === 'service') changed.services[0].name = 'changed';
    if (field === 'environment') changed.environments[0].name = 'changed';
    if (field === 'revision') changed.revision++;
    const before = structuredClone(changed);
    expect(() => applyOpenApiPreview(changed, p, [p.rows[0].key])).toThrow(/过期|变更|变化/);
    expect(changed).toEqual(before);
  });

  it('新项目确认复用导入边界，并只导入勾选接口及其变量', () => {
    const w = emptyWorkspace();
    const parsed = parseOpenApi(source({ '/users/{id}': { get: operation({
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
    }) }, '/other': { get: operation() } }));
    const p = previewOpenApi(w, parsed), next = applyOpenApiPreview(w, p, [p.rows[0].key]);
    expect(w.projects).toHaveLength(0);
    expect(next.projects).toHaveLength(1);
    expect(next.services).toHaveLength(1);
    expect(next.requests).toHaveLength(1);
    expect(next.variables[0].ownerId).toBe(next.requests[0].id);
    expect(next.requests[0].path).toBe('/users/{{id}}');
  });

  it('更新新增接口不更改项目、服务或现有配置，非法目标/伪造预览/空选择不可应用', () => {
    const w = demoWorkspace(), parsed = doc(), p = previewOpenApi(w, parsed, target);
    const next = applyOpenApiPreview(w, p, [p.rows[1].key]);
    expect(next.projects).toEqual(w.projects);
    expect(next.services).toEqual(w.services);
    expect(next.requests.slice(0, 2)).toEqual(w.requests);
    expect(next.requests[2]).toMatchObject({ serviceId: 'demo-users', path: '/new' });
    expect(() => previewOpenApi(w, parsed, { ...target, serviceId: 'missing' })).toThrow();
    expect(() => applyOpenApiPreview(w, structuredClone(p), [p.rows[0].key])).toThrow();
    expect(() => applyOpenApiPreview(w, p, [])).toThrow();
  });

  it('请求身份重复不能更新其他服务的同 id 请求，服务身份重复不能跨项目选中', () => {
    const w = demoWorkspace();
    w.requests.push({ ...structuredClone(w.requests[0]), serviceId: 'demo-orders', query: [] });
    const p = previewOpenApi(w, doc(), target);
    expect(p.rows[0].kind).toBe('blocked');
    const another = demoWorkspace();
    another.services.push({ ...another.services[0], projectId: 'other-project' });
    expect(() => previewOpenApi(another, doc(), target)).toThrow();
  });

  it('新接口目录重名在预览阻止，不妨碍仅补齐其他已有接口参数', () => {
    const w = demoWorkspace();
    w.folders.push(
      { id: 'd1', serviceId: 'demo-users', parentId: null, name: 'duplicate' },
      { id: 'd2', serviceId: 'demo-users', parentId: null, name: 'duplicate' },
    );
    const parsed = parseOpenApi(source({
      '/users': { get: operation({ parameters: [{ in: 'query', name: 'limit', schema: { default: 20 } }] }) },
      '/new': { get: operation({ tags: ['duplicate'] }) },
    }));
    const p = previewOpenApi(w, parsed, target);
    expect(p.rows[1].kind).toBe('blocked');
    expect(applyOpenApiPreview(w, p, [p.rows[0].key]).requests[0].query).toHaveLength(2);
  });

  it('返回预览与文档被调用方改动不能改变已检查计划', () => {
    const w = demoWorkspace(), parsed = doc(), p = previewOpenApi(w, parsed, target);
    parsed.bundle.workspace.requests[0].headers.push({ id: 'evil', key: 'Authorization', value: 'bad', enabled: true });
    p.rows[0].updates.push('伪造内容');
    const next = applyOpenApiPreview(w, p, [p.rows[0].key]);
    expect(next.requests[0].headers.map(h => h.key)).toEqual(['X-New']);
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('新导入复用原流程但绝不改动已有凭据、秘密变量或任何环境覆盖', () => {
    const w = demoWorkspace();
    w.services[0].auth = { kind: 'bearer', token: '{{service_token}}' };
    w.services[0].headers = [{ id: 'sh', key: 'Authorization', value: 'Bearer {{service_token}}', enabled: true }];
    w.requests[0].auth = { kind: 'basic', username: 'local-user', password: '{{password}}' };
    w.requests[0].headers = [{ id: 'h', key: 'X-Api-Key', value: '{{apiKey}}', enabled: false }];
    w.requests[0].environmentConfigs = { 'demo-prod': {
      query: [{ id: 'eq', key: 'token', value: '{{prod_token}}', enabled: true }],
      headers: [], auth: { kind: 'bearer', token: '{{prod_token}}' },
      bodyType: 'json', body: '{"local":"business data"}', timeoutMs: 8000,
    } };
    w.variables.push({ id: 'v', projectId: 'demo-project', scope: 'service', ownerId: 'demo-users',
      name: 'service_token', value: 'keep-this-real-local-secret', isSecret: true });
    const original = structuredClone(w), p = previewOpenApi(w, doc());
    const next = applyOpenApiPreview(w, p, [p.rows[0].key]);
    for (const field of ['services', 'requests', 'variables', 'bindings', 'environments', 'folders'] as const) {
      expect(next[field].slice(0, original[field].length)).toEqual(original[field]);
    }
    expect(w).toEqual(original);
  });
});
