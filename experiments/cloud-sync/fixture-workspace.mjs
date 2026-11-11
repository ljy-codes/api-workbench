// Synthetic fixture. Never loads EnvDock's real workspace.
export function exampleWorkspace() {
  return {
    revision: 7, activeProjectId: 'project-demo',
    projects: [{ id: 'project-demo', name: '虚构项目', activeEnvironmentId: 'env-demo' }],
    environments: [{ id: 'env-demo', projectId: 'project-demo', name: '测试', isProduction: false }],
    services: [{ id: 'service-demo', projectId: 'project-demo', name: '示例服务' }],
    bindings: [{
      id: 'binding-demo', projectId: 'project-demo', serviceId: 'service-demo',
      environmentId: 'env-demo', baseUrl: 'https://example.invalid', enabled: true,
    }],
    folders: [{ id: 'folder-demo', serviceId: 'service-demo', parentId: null, name: '示例目录' }],
    requests: [{
      id: 'request-demo', serviceId: 'service-demo', folderId: 'folder-demo', name: '查询示例',
      method: 'POST', path: '/demo', query: [], headers: [], bodyType: 'json',
      body: '{"demo":"body-marker-to-encrypt"}', timeoutMs: 30000,
      form: [{ id: 'file-demo', key: 'file', kind: 'file', value: 'C:\\private\\sample.txt', enabled: true }],
    }],
    variables: [
      { id: 'v-plain', projectId: 'project-demo', scope: 'project', ownerId: 'project-demo', name: 'size', value: '10', isSecret: false },
      { id: 'v-secret', projectId: 'project-demo', scope: 'project', ownerId: 'project-demo', name: 'token', value: 'device-only-marker', isSecret: true },
    ],
  };
}
