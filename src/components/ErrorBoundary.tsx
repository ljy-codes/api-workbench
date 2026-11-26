import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): State {
    return { error, componentStack: '' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, componentStack: info.componentStack ?? '' });
    // Keep diagnostics local. The desktop app has no telemetry channel.
    console.error('EnvDock 渲染失败', error, info.componentStack);
  }

  private reload = () => window.location.reload();

  private copyDiagnostics = async () => {
    const { error, componentStack } = this.state;
    const text = [
      'EnvDock 渲染失败',
      `${error?.name ?? 'Error'}: ${error?.message ?? '未知错误'}`,
      error?.stack ?? '',
      componentStack,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard access can be unavailable in the browser preview.
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 32, background: 'var(--bg, #22262e)', color: 'var(--text, #e0e5ed)' }}>
        <section style={{ maxWidth: 620, width: '100%', padding: 28, border: '1px solid var(--border, #424c59)', borderRadius: 12, background: 'var(--panel, #282d36)' }}>
          <p className="eyebrow">ENVDOCK RECOVERY</p>
          <h1>工作区遇到意外错误</h1>
          <p>可以重新加载应用；如果问题仍然出现，请复制诊断信息用于本地排查。</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="primary" onClick={this.reload}>重新加载应用</button>
            <button onClick={() => void this.copyDiagnostics()}>复制诊断信息</button>
          </div>
        </section>
      </main>
    );
  }
}
