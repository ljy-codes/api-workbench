import { describe, expect, it, vi } from 'vitest';
import { detectImport, exportSelection, importSelection } from './transfer';
import { emptyWorkspace } from './workspace';

const schema = (v: string) => `https://schema.getpostman.com/json/collection/v${v}/collection.json`;
const postman = (v = '2.1.0') => ({
  info: { name: '合成 Postman', schema: schema(v) },
  variable: [{ key: 'base', value: 'https://api.example.com/v1' }, { key: 'token', value: 'PRIVATE_TOKEN' }],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
  event: [{ listen: 'prerequest', script: { exec: ['throw "never execute"'] } }],
  item: [{ name: '父目录', item: [{ name: '子目录', item: [{
    name: '创建', request: {
      method: 'POST', url: { raw: '{{base}}/users?q=yes', query: [{ key: 'q', value: 'yes' }, { key: 'off', value: 'x', disabled: true }] },
      header: [{ key: 'Accept', value: 'application/json' }, { key: 'Authorization', value: 'Bearer PRIVATE_HEADER' }],
      body: { mode: 'raw', raw: '{"name":"{{name}}"}', options: { raw: { language: 'json' } } },
    },
  }] }] }],
});
// Synthetic resources following mountain-loop/yaak v2026.9.0:
// crates/yaak-models/{src/util.rs,bindings/gen_models.ts}, plugins/importer-yaak/src/index.ts.
const yaak = () => ({
  yaakSchema: 4, yaakVersion: '2026.9.0', resources: {
    workspaces: [{ id: 'w1', model: 'workspace', name: 'Yaak 合成', headers: [{ name: 'X-Root', value: 'yes' }] }],
    environments: [
      { id: 'e0', workspaceId: 'w1', name: 'Base', base: true, variables: [{ name: 'base', value: 'https://base.example.com/v1' }, { name: 'token', value: 'PRIVATE_YAAK' }, { name: 'common', value: 'yes' }] },
      { id: 'e1', workspaceId: 'w1', name: 'Dev', base: false, variables: [{ name: 'base', value: 'https://dev.example.com/v1' }] },
      { id: 'e2', workspaceId: 'w1', name: 'Prod', parentModel: 'environment', parentId: 'e1', variables: [{ name: 'base', value: 'https://prod.example.com/v1' }] },
    ],
    folders: [
      { id: 'f1', workspaceId: 'w1', name: '父目录', folderId: null, authenticationType: 'bearer', authentication: { token: '${[ token ]}' } },
      { id: 'f2', workspaceId: 'w1', name: '子目录', folderId: 'f1', headers: [{ name: 'X-Folder', value: 'yes' }] },
    ],
    httpRequests: [{
      id: 'r1', workspaceId: 'w1', folderId: 'f2', name: '创建', method: 'POST', url: '${[ base ]}/users/:id?raw=1',
      urlParameters: [{ name: ':id', value: '${[ user_id ]}' }, { name: 'q', value: '${[ common ]}' }],
      headers: [{ name: 'X-Test', value: '${[ common ]}' }],
      bodyType: 'application/json', body: { text: '{"common":"${[ common ]}"}' },
    }],
    grpcRequests: [{ id: 'g1', workspaceId: 'w1', name: '不支持' }],
    websocketRequests: [],
  },
});

describe('official offline format adapters', () => {
  it.each(['2.0.0', '2.1.0'])('imports Postman %s collection hierarchy and HTTP templates', version => {
    const b = detectImport(JSON.stringify(postman(version))), w = b.workspace;
    expect(b.source).toMatch(/postman/i);
    expect(w.projects).toHaveLength(1);
    expect(w.environments).toHaveLength(1);
    expect(w.folders).toHaveLength(2);
    expect(w.folders[1].parentId).toBe(w.folders[0].id);
    expect(w.requests[0]).toMatchObject({ path: '/users', method: 'POST', bodyType: 'json', body: '{"name":"{{name}}"}', folderId: w.folders[1].id, auth: { kind: 'bearer', token: '{{token}}' } });
    expect(w.requests[0].query).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'q', value: 'yes' }), expect.objectContaining({ key: 'off', enabled: false })]));
    expect(w.bindings[0].baseUrl).toBe('https://api.example.com/v1');
    expect(b.warnings.join(' ')).toMatch(/脚本/);
    expect(JSON.stringify(b)).not.toMatch(/PRIVATE_(TOKEN|HEADER)/);
  });

  it('imports standalone Postman environment into its own project and default environment', () => {
    const b = detectImport(JSON.stringify({ id: 'pm-env', name: '开发环境', _postman_variable_scope: 'environment', values: [
      { key: 'base', value: 'https://example.com', enabled: true }, { key: 'token', value: 'PRIVATE_SECRET', type: 'secret' },
      { key: 'disabled', value: 'omitted', enabled: false },
    ] }));
    expect(b.workspace.projects).toHaveLength(1);
    expect(b.workspace.projects[0].activeEnvironmentId).toBe(b.workspace.environments[0].id);
    expect(b.workspace.variables.find(v => v.name === 'base')?.scope).toBe('environment');
    expect(JSON.stringify(b)).not.toContain('PRIVATE_SECRET');
    expect(b.workspace.variables.some(v => v.name === 'disabled')).toBe(false);
    expect(b.warnings.join(' ')).toMatch(/禁用/);
  });

  it('imports official Yaak resources, flattens environments, binds hosts and converts syntax', () => {
    const b = detectImport(JSON.stringify(yaak())), w = b.workspace;
    expect(b.source).toMatch(/yaak/i);
    expect(w.folders[1].parentId).toBe(w.folders[0].id);
    expect(w.requests[0]).toMatchObject({
      path: '/users/{{user_id}}', bodyType: 'json', body: '{"common":"{{common}}"}',
      auth: { kind: 'bearer', token: '{{token}}' },
    });
    expect(w.requests[0].headers.map(p => p.key)).toEqual(expect.arrayContaining(['X-Root', 'X-Folder', 'X-Test']));
    expect(w.requests[0].query.map(p => p.key)).toEqual(['raw', 'q']);
    expect(w.bindings.map(b => b.baseUrl)).toEqual(expect.arrayContaining(['https://dev.example.com/v1', 'https://prod.example.com/v1']));
    const prod = w.environments.find(e => e.name === 'Prod')!;
    expect(w.variables.filter(v => v.ownerId === prod.id)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'common', value: 'yes' })]));
    expect(JSON.stringify(b)).not.toContain('PRIVATE_YAAK');
    expect(b.warnings.join(' ')).toMatch(/gRPC/i);
    const text = exportSelection(w, { [w.projects[0].id]: [prod.id] });
    expect(text).not.toContain('https://dev.example.com');
    expect(text).not.toContain('https://base.example.com');
  });

  it('accepts Yaak YAML resource envelope and official per-model sync documents', () => {
    const b = detectImport('yaakSchema: 4\nresources:\n  workspaces:\n    - id: w1\n      name: YAML\n  httpRequests:\n    - id: r1\n      workspaceId: w1\n      name: Read\n      method: GET\n      url: https://example.com/read\n');
    expect(b.workspace.requests[0].path).toBe('/read');
    const sync = detectImport('type: workspace\nmodel: workspace\nid: w1\nname: Sync\n---\ntype: http_request\nmodel: http_request\nid: r1\nworkspaceId: w1\nname: Sync request\nurl: https://example.com/sync\nmethod: GET\n');
    expect(sync.workspace.requests[0].path).toBe('/sync');
    expect(() => detectImport('model: http_request\nid: r1\nworkspaceId: missing\nurl: https://example.com\n')).toThrow(/引用|工作区/);
  });

  it('supports legacy Yaak schema requests and workspace variables', () => {
    const b = detectImport(JSON.stringify({ yaakSchema: 1, resources: {
      workspaces: [{ id: 'w', name: '旧版', variables: [{ name: 'base', value: 'https://legacy.example.com' }] }],
      requests: [{ id: 'r', workspaceId: 'w', name: '旧请求', method: 'GET', url: '${[ base ]}/read' }],
    } }));
    expect(b.workspace.bindings[0].baseUrl).toBe('https://legacy.example.com');
    expect(b.workspace.requests[0].path).toBe('/read');
  });

  it.each([
    (x: ReturnType<typeof yaak>) => { x.resources.httpRequests[0].folderId = 'missing'; },
    (x: ReturnType<typeof yaak>) => { x.resources.folders[0].folderId = 'f2'; },
    (x: ReturnType<typeof yaak>) => { x.resources.environments[2].parentId = 'e2'; },
    (x: ReturnType<typeof yaak>) => { x.resources.httpRequests[0].id = 'w1'; },
    (x: ReturnType<typeof yaak>) => { x.resources.httpRequests[0].workspaceId = 'missing'; },
  ])('rejects invalid Yaak relations and duplicate IDs', mutate => {
    const x = yaak(); mutate(x);
    expect(() => detectImport(JSON.stringify(x))).toThrow();
  });

  it('warns on unsupported protocols/auth/body/templates without executing or losing supported requests', () => {
    const x = yaak();
    Object.assign(x.resources.httpRequests[0], { authenticationType: 'oauth2', authentication: { token: 'PRIVATE_UNSUPPORTED' }, body: { text: '${[ response("x") ]}' } });
    const b = detectImport(JSON.stringify(x));
    expect(b.workspace.requests).toHaveLength(1);
    expect(b.warnings.join(' ')).toMatch(/鉴权/);
    expect(b.warnings.join(' ')).toMatch(/模板/);
    expect(JSON.stringify(b)).not.toContain('PRIVATE_UNSUPPORTED');
    const pm = postman();
    pm.item[0].item[0].item.push({ name: 'socket', request: { method: 'GET', url: { raw: 'wss://example.com' } } } as never);
    expect(detectImport(JSON.stringify(pm)).warnings.join(' ')).toMatch(/协议/);
  });

  it.each([
    'yaakSchema: 4\nresources: &a {workspaces: [*a]}',
    'yaakSchema: 4\nyaakSchema: 4\nresources: {}',
    'yaakSchema: 4\nresources: {constructor: {x: y}}',
    '!!js/function function() {}',
    JSON.stringify({ yaakSchema: 999, resources: yaak().resources }),
  ])('fails unsafe/unknown YAML and versions without changing target', text => {
    const target = emptyWorkspace(), before = structuredClone(target);
    expect(() => {
      const b = detectImport(text);
      importSelection(target, b, Object.fromEntries(b.workspace.projects.map(p => [p.id, []])));
    }).toThrow();
    expect(target).toEqual(before);
  });

  it('retains empty Postman folders and raw query when URL query metadata is absent', () => {
    const x = postman();
    x.item.push({ name: '空目录', item: [] } as never);
    const r = x.item[0].item[0].item[0].request;
    delete (r.url as { query?: unknown }).query;
    const w = detectImport(JSON.stringify(x)).workspace;
    expect(w.folders.some(f => f.name === '空目录')).toBe(true);
    expect(w.requests[0].query[0]).toMatchObject({ key: 'q', value: 'yes' });
  });

  it('accepts Postman v2.0 object auth and id-only variables', () => {
    const x = postman('2.0.0');
    x.variable = [{ id: 'base', value: 'https://legacy.example.com' }] as never;
    x.auth = { type: 'basic', basic: { username: 'PRIVATE_USER', password: 'PRIVATE_PASS' } } as never;
    const b = detectImport(JSON.stringify(x));
    expect(b.workspace.bindings[0].baseUrl).toBe('https://legacy.example.com');
    expect(b.workspace.requests[0].auth?.kind).toBe('basic');
    expect(JSON.stringify(b)).not.toMatch(/PRIVATE_(USER|PASS)/);
  });

  it.each(['postman', 'yaak'])('converts %s form bodies and disables file paths', format => {
    let value: unknown;
    if (format === 'postman') {
      const x = postman();
      x.item[0].item[0].item[0].request.body = { mode: 'formdata', formdata: [
        { key: 'name', value: '{{name}}', type: 'text' }, { key: 'password', value: 'PRIVATE_FORM', type: 'text' },
        { key: 'upload', type: 'file', src: 'C:\\PRIVATE_PATH.txt' },
      ] } as never;
      value = x;
    } else {
      const x = yaak();
      x.resources.httpRequests[0].bodyType = 'multipart/form-data';
      x.resources.httpRequests[0].body = { form: [
        { name: 'name', value: '${[ name ]}', enabled: true },
        { name: 'password', value: 'PRIVATE_FORM' },
        { name: 'upload', file: 'C:\\PRIVATE_PATH.txt' },
      ] } as never;
      value = x;
    }
    const b = detectImport(JSON.stringify(value));
    expect(b.workspace.requests[0].form).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'name', value: '{{name}}', kind: 'text' }),
      expect.objectContaining({ key: 'upload', value: '', enabled: false, kind: 'file' }),
    ]));
    expect(JSON.stringify(b)).not.toMatch(/PRIVATE_(FORM|PATH)/);
  });

  it.each([
    ['application/xml', 'text', '<user/>'],
    ['text/xml', 'text', '<user/>'],
    ['application/problem+json', 'json', '{"title":"example"}'],
    ['application/ld+json', 'json', '{"@id":"example"}'],
    ['text/plain', 'text', 'plain body'],
    ['application/json', 'json', '{"name":"example"}'],
  ])('preserves Yaak %s MIME through body conversion and round trip', (mime, bodyType, text) => {
    const source = yaak();
    Object.assign(source.resources.httpRequests[0], { bodyType: mime, body: { text } });
    const bundle = detectImport(JSON.stringify(source)), w = bundle.workspace;
    const checkMime = (workspace: typeof w) => {
      const r = workspace.requests[0];
      expect(r).toMatchObject({ bodyType, body: text });
      expect(r.headers.filter(h => h.enabled && h.key.toLowerCase() === 'content-type')).toEqual([
        expect.objectContaining({ value: mime }),
      ]);
    };
    checkMime(w);
    const exported = detectImport(exportSelection(w, { [w.projects[0].id]: w.environments.map(e => e.id) }));
    checkMime(importSelection(emptyWorkspace(), exported, {
      [exported.workspace.projects[0].id]: exported.workspace.environments.map(e => e.id),
    }));
  });

  describe.each(['2.0.0', '2.1.0'])('Postman %s raw content types', version => {
    it.each([
      ['xml', 'application/xml', 'text', '<user/>'],
      ['html', 'text/html', 'text', '<p>example</p>'],
      ['javascript', 'application/javascript', 'text', 'const example = true;'],
      ['text', 'text/plain', 'text', 'plain body'],
      ['json', 'application/json', 'json', '{"name":"example"}'],
    ])('maps %s to %s through conversion and round trip', (language, mime, bodyType, text) => {
      const source = postman(version), raw = source.item[0].item[0].item[0].request.body;
      raw.options.raw.language = language; raw.raw = text;
      const bundle = detectImport(JSON.stringify(source)), w = bundle.workspace;
      const checkMime = (workspace: typeof w) => {
        const r = workspace.requests[0];
        expect(r).toMatchObject({ bodyType, body: text });
        expect(r.headers.filter(h => h.enabled && h.key.toLowerCase() === 'content-type')).toEqual([
          expect.objectContaining({ value: mime }),
        ]);
      };
      checkMime(w);
      const exported = detectImport(exportSelection(w, { [w.projects[0].id]: w.environments.map(e => e.id) }));
      checkMime(importSelection(emptyWorkspace(), exported, {
        [exported.workspace.projects[0].id]: exported.workspace.environments.map(e => e.id),
      }));
    });
  });

  it.each(['postman', 'yaak'])('prioritizes enabled case-insensitive explicit %s Content-Type', format => {
    const source = format === 'postman' ? postman() : yaak();
    const explicit = 'application/custom+xml; charset=UTF-8';
    if ('item' in source) {
      const r = source.item[0].item[0].item[0].request;
      r.body = { mode: 'raw', raw: '<user/>', options: { raw: { language: 'xml' } } };
      r.header = [
        { key: 'Content-Type', value: 'application/json', disabled: true },
        { key: 'cOnTeNt-TyPe', value: explicit },
      ] as never;
    } else Object.assign(source.resources.httpRequests[0], {
      bodyType: 'application/xml', body: { text: '<user/>' }, headers: [
        { name: 'Content-Type', value: 'application/json', enabled: false },
        { name: 'cOnTeNt-TyPe', value: explicit, enabled: true },
      ],
    });
    const r = detectImport(JSON.stringify(source)).workspace.requests[0];
    expect(r).toMatchObject({ bodyType: 'text', body: '<user/>' });
    expect(r.headers.filter(h => h.enabled && h.key.toLowerCase() === 'content-type')).toEqual([
      expect.objectContaining({ key: 'cOnTeNt-TyPe', value: explicit }),
    ]);
  });

  it.each(['postman', 'yaak'])('adds source MIME when explicit %s Content-Type is disabled', format => {
    const source = format === 'postman' ? postman() : yaak();
    if ('item' in source) {
      const r = source.item[0].item[0].item[0].request;
      r.body = { mode: 'raw', raw: '<user/>', options: { raw: { language: 'xml' } } };
      r.header = [{ key: 'Content-Type', value: 'application/json', disabled: true }] as never;
    } else Object.assign(source.resources.httpRequests[0], {
      bodyType: 'text/xml', body: { text: '<user/>' }, headers: [{ name: 'Content-Type', value: 'application/json', enabled: false }],
    });
    const r = detectImport(JSON.stringify(source)).workspace.requests[0];
    expect(r).toMatchObject({ bodyType: 'text', body: '<user/>' });
    expect(r.headers.filter(h => h.enabled && h.key.toLowerCase() === 'content-type')).toEqual([
      expect.objectContaining({ value: format === 'postman' ? 'application/xml' : 'text/xml' }),
    ]);
    expect(r.headers).toContainEqual(expect.objectContaining({ value: 'application/json', enabled: false }));
  });

  it('honors Yaak inherited explicit Content-Type over the body MIME', () => {
    const source = yaak();
    source.resources.workspaces[0].headers.push({ name: 'Content-Type', value: 'application/custom+xml' });
    Object.assign(source.resources.httpRequests[0], { bodyType: 'text/xml', body: { text: '<user/>' } });
    const r = detectImport(JSON.stringify(source)).workspace.requests[0];
    expect(r.headers.filter(h => h.enabled && h.key.toLowerCase() === 'content-type')).toEqual([
      expect.objectContaining({ value: 'application/custom+xml' }),
    ]);
  });

  it.each(['postman', 'yaak'])('does not add a %s multipart Content-Type without a native boundary', format => {
    const source = format === 'postman' ? postman() : yaak();
    if ('item' in source) source.item[0].item[0].item[0].request.body = {
      mode: 'formdata', formdata: [{ key: 'name', value: 'example', type: 'text' }],
    } as never;
    else Object.assign(source.resources.httpRequests[0], {
      bodyType: 'multipart/form-data', body: { form: [{ name: 'name', value: 'example', enabled: true }] },
    });
    const r = detectImport(JSON.stringify(source)).workspace.requests[0];
    expect(r.bodyType).toBe('multipart');
    expect(r.headers.some(h => h.key.toLowerCase() === 'content-type')).toBe(false);
  });

  it('preserves multiple Yaak workspaces and round trips their relations', () => {
    const x = yaak();
    x.resources.workspaces.push({ id: 'w2', model: 'workspace', name: '二号', headers: [] });
    const first = detectImport(JSON.stringify(x));
    const selection = Object.fromEntries(first.workspace.projects.map(p => [p.id, first.workspace.environments.filter(e => e.projectId === p.id).map(e => e.id)]));
    const second = detectImport(exportSelection(first.workspace, selection));
    const target = importSelection(emptyWorkspace(), second, Object.fromEntries(second.workspace.projects.map(p => [p.id, second.workspace.environments.filter(e => e.projectId === p.id).map(e => e.id)])));
    expect(target.projects).toHaveLength(2);
    expect(target.requests[0].folderId).toBe(target.folders[1].id);
    expect(target.bindings.every(b => target.environments.some(e => e.id === b.environmentId && e.projectId === b.projectId))).toBe(true);
  });

  it('applies Yaak folder variables to host bindings without leaking scope into sibling requests', () => {
    const x = yaak();
    x.resources.environments.push({
      id: 'ef', workspaceId: 'w1', name: 'Folder', parentModel: 'folder', parentId: 'f2',
      variables: [{ name: 'base', value: 'https://folder.example.com/api' }, { name: 'local', value: 'only-folder' }],
    });
    x.resources.httpRequests.push({ ...x.resources.httpRequests[0], id: 'r2', folderId: null } as never);
    const w = detectImport(JSON.stringify(x)).workspace;
    const folderRequest = w.requests[0], sibling = w.requests[1];
    expect(w.bindings.filter(b => b.serviceId === folderRequest.serviceId).map(b => b.baseUrl)).toEqual(['https://folder.example.com/api', 'https://folder.example.com/api', 'https://folder.example.com/api']);
    expect(sibling.serviceId).not.toBe(folderRequest.serviceId);
    expect(w.variables.some(v => v.ownerId === sibling.id && v.name === 'local')).toBe(false);
    expect(w.environments.some(e => e.name === 'Folder')).toBe(false);
  });

  it('handles variables in the URL scheme and host with a stable shared path', () => {
    const x = postman();
    x.variable.push({ key: 'scheme', value: 'https' }, { key: 'host', value: 'api.example.com' });
    x.item[0].item[0].item[0].request.url.raw = '{{scheme}}://{{host}}/users';
    const w = detectImport(JSON.stringify(x)).workspace;
    expect(w.requests[0].path).toBe('/users');
    expect(w.bindings[0].baseUrl).toBe('https://api.example.com');
  });

  it('does not copy auth-referenced or secret variables into literal host bindings', () => {
    const x = postman();
    x.variable.push({ key: 'host', value: 'PRIVATE_HOST.example.com' });
    x.auth = { type: 'bearer', bearer: [{ key: 'token', value: '{{host}}' }] };
    x.item[0].item[0].item[0].request.url.raw = 'https://{{host}}/users';
    const b = detectImport(JSON.stringify(x));
    expect(JSON.stringify(b)).not.toContain('PRIVATE_HOST');
    expect(b.workspace.bindings[0].baseUrl).toBe('');
    expect(b.warnings.join(' ')).toMatch(/绑定|域名/);
  });

  it.each(['postman', 'yaak'])('scrubs sensitive %s URL query values before preview and round trip', format => {
    const url = 'https://example.com/users?access_token=PRIVATE_URL&ordinary=visible';
    const source = format === 'postman' ? postman() : yaak();
    if ('item' in source) source.item[0].item[0].item[0].request.url = { raw: url } as never;
    else source.resources.httpRequests[0].url = url;
    const bundle = detectImport(JSON.stringify(source)), w = bundle.workspace;
    expect(JSON.stringify(bundle)).not.toContain('PRIVATE_URL');
    expect(w.requests[0].query).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'access_token', value: expect.stringMatching(/^\{\{.+\}\}$/) }),
      expect.objectContaining({ key: 'ordinary', value: 'visible' }),
    ]));
    const selection = { [w.projects[0].id]: w.environments.map(e => e.id) };
    expect(exportSelection(w, selection)).not.toContain('PRIVATE_URL');
    expect(JSON.stringify(importSelection(emptyWorkspace(), bundle, selection))).not.toContain('PRIVATE_URL');
  });

  it.each([
    'https://PRIVATE_USER:PRIVATE_PASS@example.com/users',
    'https://example.com?access_token=PRIVATE_URL',
  ])('rejects credentials in literal or variable host URLs without echoing them', url => {
    const source = postman();
    if (url.includes('@')) source.item[0].item[0].item[0].request.url = { raw: url } as never;
    else source.variable[0].value = url;
    expect(() => detectImport(JSON.stringify(source))).toThrow();
    try { detectImport(JSON.stringify(source)); } catch (error) { expect(String(error)).not.toContain('PRIVATE_'); }
  });

  it('enforces YAML UTF-8 byte and nesting limits before conversion', () => {
    const yaml = 'model: workspace\nid: w1\nname: YAML\n';
    const oversized = yaml + ('#' + '密'.repeat(1024) + '\n').repeat(3500);
    expect(oversized.length).toBeLessThan(10 * 1024 * 1024);
    expect(() => detectImport(oversized)).toThrow(/10 MiB/);
    expect(() => detectImport(yaml + 'extra: ' + '['.repeat(40) + '0' + ']'.repeat(40))).toThrow(/上限/);
  });

  it('stops environment × service expansion before allocating over the entity budget', () => {
    const source = { yaakSchema: 4, resources: {
      workspaces: [{ id: 'w', name: 'Bounded' }],
      environments: Array.from({ length: 200 }, (_, n) => ({ id: `e${n}`, workspaceId: 'w', name: `E${n}`, base: n === 0, variables: [] })),
      httpRequests: Array.from({ length: 200 }, (_, n) => ({ id: `r${n}`, workspaceId: 'w', name: 'R', method: 'GET', url: `https://host${n}.example.com/read` })),
    } };
    const allocation = vi.spyOn(crypto, 'randomUUID');
    try {
      expect(() => detectImport(JSON.stringify(source))).toThrow(/上限|数量/);
      expect(allocation.mock.calls.length).toBeLessThanOrEqual(20000);
    } finally { allocation.mockRestore(); }
  });
});
