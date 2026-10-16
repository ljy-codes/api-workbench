import { useMemo } from 'react';
import { ArrowRight, Braces, ChevronRight, FolderClosed, Globe2, Layers3, Plus, Server, Settings2, Waypoints } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import type { EntityEditTarget } from './EntityEditor';
import { ColorDot, ENVIRONMENT_COLOR, PROJECT_COLOR } from './ColorPicker';
import './Dashboard.css';

type Destination = 'requests' | 'environments' | 'variables' | 'manage';
interface Props {
  model: Workbench;
  onNavigate: (page: Destination) => void;
  onOpenRequest: (id: string) => void;
  onCreate: (target: EntityEditTarget) => void;
}

export function Dashboard({ model, onNavigate, onOpenRequest, onCreate }: Props) {
  const { workspace, project, environment, openTabs } = model;
  const data = useMemo(() => {
    const services = workspace.services.filter(s => s.projectId === project?.id);
    const serviceIds = new Set(services.map(s => s.id));
    const requests = workspace.requests.filter(r => serviceIds.has(r.serviceId));
    const requestById = new Map(requests.map(r => [r.id, r]));
    const environments = workspace.environments.filter(e => e.projectId === project?.id);
    const configured = new Map(environments.map(e => [e.id, new Set<string>()]));
    for (const binding of workspace.bindings) {
      if (binding.projectId === project?.id && serviceIds.has(binding.serviceId) && binding.enabled && binding.baseUrl.trim()) {
        configured.get(binding.environmentId)?.add(binding.serviceId);
      }
    }
    const serviceCounts = new Map<string, number>();
    const methods = new Map<string, number>();
    for (const request of requests) {
      serviceCounts.set(request.serviceId, (serviceCounts.get(request.serviceId) ?? 0) + 1);
      const method = request.method.toUpperCase();
      methods.set(method, (methods.get(method) ?? 0) + 1);
    }
    const opened = (openTabs ?? []).flatMap(id => {
      const request = requestById.get(id);
      return request ? [request] : [];
    }).reverse();
    return {
      services: services.map(s => ({ ...s, count: serviceCounts.get(s.id) ?? 0 })).sort((a, b) => b.count - a.count),
      serviceById: new Map(services.map(s => [s.id, s])),
      requests, environments, configured, opened,
      folderCount: workspace.folders.filter(f => serviceIds.has(f.serviceId)).length,
      methods: [...methods].sort((a, b) => b[1] - a[1]),
    };
  }, [workspace, project?.id, openTabs]);

  if (!project) return <section className="dashboard dashboard-onboarding" aria-label="项目仪表盘">
    <div className="dashboard-intro-icon"><Layers3 size={30} /></div>
    <span className="eyebrow">ENVDOCK / WORKSPACE</span>
    <h1>创建你的第一个项目</h1>
    <p>把接口、服务与环境放在一起，建立自己的本地调试工作区。</p>
    <button className="primary" onClick={() => onCreate({ kind: 'project' })}><Plus size={16} />新建项目</button>
    <ol className="dashboard-steps">
      <li><span>01</span><strong>建立项目与服务</strong><p>按业务组织接口集合</p></li>
      <li><span>02</span><strong>配置环境地址</strong><p>分开管理开发、测试与生产</p></li>
      <li><span>03</span><strong>开始接口调试</strong><p>在工作台编辑并发送请求</p></li>
    </ol>
  </section>;

  const currentConfigured = environment ? data.configured.get(environment.id) : undefined;
  const stats = [
    { label: '接口总数', value: data.requests.length, Icon: Waypoints, detail: '当前项目的全部接口', tone: 'accent' },
    { label: '服务总数', value: data.services.length, Icon: Server, detail: environment ? `${currentConfigured?.size ?? 0} 个已配置当前环境` : '尚未选择当前环境', tone: 'cyan' },
    { label: '环境总数', value: data.environments.length, Icon: Globe2, detail: `${data.environments.filter(e => e.isProduction).length} 个生产环境`, tone: 'warning' },
    { label: '目录总数', value: data.folderCount, Icon: FolderClosed, detail: '按业务分层整理', tone: 'muted' },
  ];
  const creationServiceId = model.request?.serviceId ?? data.services[0]?.id;

  return <section className="dashboard" aria-label="项目仪表盘">
    <header className="dashboard-heading">
      <div><div className="dashboard-breadcrumb"><span className="eyebrow">WORKSPACE OVERVIEW</span><span>/</span><ColorDot color={project.color} fallback={PROJECT_COLOR} /><span className="ellipsis">{project.name}</span></div>
        <h1>项目概览</h1><p>查看接口分布与环境配置，继续手边的调试。</p></div>
      <button className="primary" onClick={() => onNavigate('requests')}>进入接口工作台<ArrowRight size={16} /></button>
    </header>

    <ul className="dashboard-stats" aria-label="项目统计">{stats.map(({ label, value, Icon, detail, tone }) =>
      <li className={`dashboard-stat dashboard-tone-${tone}`} aria-label={label} key={label}>
        <div><span>{label}</span><Icon size={17} aria-hidden="true" /></div>
        <strong>{value.toLocaleString('zh-CN')}</strong><small>{detail}</small>
      </li>)}</ul>

    <div className="dashboard-shortcuts" aria-label="快捷操作">
      <button onClick={() => onCreate(creationServiceId ? { kind: 'request', serviceId: creationServiceId } : { kind: 'service' })}><Plus size={16} />{creationServiceId ? '新建接口' : '新建服务'}<ChevronRight size={14} /></button>
      <button onClick={() => onNavigate('environments')}><Globe2 size={16} />配置环境<ChevronRight size={14} /></button>
      <button onClick={() => onNavigate('variables')}><Braces size={16} />管理变量<ChevronRight size={14} /></button>
      <button onClick={() => onNavigate('manage')}><Settings2 size={16} />管理工作区<ChevronRight size={14} /></button>
    </div>

    <div className="dashboard-grid">
      <section className="dashboard-card" aria-label="服务接口分布">
        <header><div><h2>服务接口分布</h2><p>按接口数量排列 · 共 {data.services.length} 个服务</p></div><Server size={18} /></header>
        <div className="dashboard-card-body">
          {data.services.length ? <ul className="dashboard-services">{data.services.slice(0, 6).map(service =>
            <li key={service.id}>
              <div className="dashboard-service-label"><span className="ellipsis" title={service.name}>{service.name}</span><strong>{service.count}<small> 个接口</small></strong></div>
              <div className="dashboard-service-detail"><div className="dashboard-track" aria-hidden="true"><span style={{ width: `${data.requests.length ? service.count / data.requests.length * 100 : 0}%` }} /></div><span className={currentConfigured?.has(service.id) ? 'dashboard-configured' : 'dashboard-unconfigured'}>{currentConfigured?.has(service.id) ? '已配置' : '待配置'}</span></div>
            </li>)}</ul> : <div className="dashboard-empty"><Server size={24} /><p>还没有服务</p><small>新建服务后，在这里查看接口分布。</small></div>}
        </div>
        <footer><span>{environment ? `${environment.name} · 地址配置` : '尚未选择当前环境'}</span><button className="text-button" onClick={() => onNavigate('manage')}>管理服务<ArrowRight size={13} /></button></footer>
      </section>

      <section className="dashboard-card" aria-label="请求方法分布">
        <header><div><h2>请求方法分布</h2><p>当前项目的 HTTP 接口组成</p></div><Waypoints size={18} /></header>
        <div className="dashboard-card-body">
          {data.methods.length ? <><div className="dashboard-method-summary"><strong>{data.requests.length.toLocaleString('zh-CN')}</strong><span>个接口 / {data.methods.length} 种方法</span></div>
            <div className="dashboard-method-stack" aria-hidden="true">{data.methods.map(([method, count]) => <span className={`dashboard-method-color dashboard-method-${method}`} key={method} style={{ flex: count }} />)}</div>
            <ul className="dashboard-methods">{data.methods.map(([method, count]) => <li key={method}><span className={`dashboard-method-dot dashboard-method-color dashboard-method-${method}`} aria-hidden="true" /><code>{method}</code><strong>{count}</strong><small>{Math.round(count / data.requests.length * 100)}%</small></li>)}</ul>
          </> : <div className="dashboard-empty"><Waypoints size={24} /><p>还没有接口数据</p><small>创建接口后自动显示方法分布。</small></div>}
        </div>
      </section>

      <section className="dashboard-card" aria-label="继续调试">
        <header><div><h2>继续调试</h2><p>当前项目已打开的 {data.opened.length} 个接口</p></div><Layers3 size={18} /></header>
        <div className="dashboard-card-body dashboard-opened">
          {data.opened.length ? data.opened.slice(0, 5).map(request => <button key={request.id} className="dashboard-request" aria-label={`继续调试 ${request.name}`} onClick={() => onOpenRequest(request.id)}>
            <span className={`method method-${request.method}`}>{request.method}</span><span className="dashboard-request-info"><strong className="ellipsis">{request.name}</strong><small className="ellipsis" title={request.path}>{data.serviceById.get(request.serviceId)?.name} · {request.path}</small></span><ChevronRight size={15} />
          </button>) : <div className="dashboard-empty"><Layers3 size={24} /><p>还没有打开的接口</p><small>从左侧选择一个接口开始调试。</small></div>}
        </div>
        <footer><span>草稿与响应保留在工作台</span><button className="text-button" onClick={() => onNavigate('requests')}>打开工作台<ArrowRight size={13} /></button></footer>
      </section>

      <section className="dashboard-card" aria-label="环境概览">
        <header><div><h2>环境概览</h2><p>已配置地址的服务 / 全部服务</p></div><Globe2 size={18} /></header>
        <div className="dashboard-card-body">
          {data.environments.length ? <ul className="dashboard-environments">{data.environments.slice(0, 6).map(env => <li key={env.id}>
            <div className="dashboard-environment-label"><ColorDot color={env.color} fallback={ENVIRONMENT_COLOR} /><strong className="ellipsis" title={env.name}>{env.name}</strong>{env.isProduction && <span className="production-tag">生产</span>}{env.id === environment?.id && <span className="dashboard-current">当前</span>}</div>
            <span className="dashboard-coverage" aria-label={`${env.name}配置覆盖`}>{data.configured.get(env.id)?.size ?? 0} / {data.services.length}</span>
          </li>)}</ul> : <div className="dashboard-empty"><Globe2 size={24} /><p>还没有环境</p><small>添加环境并为服务配置基础地址。</small></div>}
        </div>
        <footer><span>共 {data.environments.length} 个环境 · 仅统计配置</span><button className="text-button" onClick={() => onNavigate('environments')}>查看矩阵<ArrowRight size={13} /></button></footer>
      </section>
    </div>
  </section>;
}
