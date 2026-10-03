import { useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Workbench } from '../hooks/useWorkbench';
import { errorMessage } from '../lib/workspace';

type CleanupModel = Pick<Workbench, 'busy' | 'loading' | 'hasRunning' | 'confirmation' | 'confirm' | 'cleanData'>;
export function DataCleanup({ model }: { model: CleanupModel }) {
  const [clearRequestBodies, setClearRequestBodies] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const current = useRef(model);
  current.current = model;
  const blocked = model.busy || model.loading || model.hasRunning;
  const clean = async () => {
    if (lock.current || blocked || model.confirmation) return;
    lock.current = true;
    setPending(true); setFeedback('');
    try {
      const accepted = await model.confirm({
        title: '确认清理所有项目的数据？',
        message: `将清除所有项目、所有环境的全部已缓存响应（不只是当前项目或环境）。\n${clearRequestBodies ? '同时清空全部接口的所有环境配置和基础模板中的请求正文和表单（包括文件项）。' : '本次保留全部请求正文和表单。'}\n保留接口路径、Query 参数、Headers、鉴权、变量及服务域名配置。清理不可撤销，请先确认已备份所需数据。\n已有手动备份不受影响，其中的数据不会被本次清理删除。`,
        danger: true, confirmLabel: '确认清理',
      });
      if (!accepted) return;
      // The confirmation can stay open while another operation starts.
      const latest = current.current;
      if (latest.busy || latest.loading || latest.hasRunning) {
        setFailed(true); setFeedback('当前有请求或操作正在进行，清理未执行，请稍后重试。'); return;
      }
      const success = await latest.cleanData(clearRequestBodies);
      setFailed(!success);
      setFeedback(success ? '数据清理完成' : '清理未完成，请查看通知并重试。');
    } catch (error) {
      setFailed(true); setFeedback(`清理未完成：${errorMessage(error)}`);
    } finally { lock.current = false; setPending(false); }
  };
  return <section className="data-cleanup management-card" aria-label="数据清理">
    <header><h2><Trash2 size={17} />数据清理</h2></header>
    <div className="data-cleanup-body">
      <p>每个接口在每个环境只缓存最新一次响应，不保存响应历史。</p>
      <p>响应缓存总上限为 64 MiB，超限自动淘汰较早的最新响应缓存。请求正文和表单不会自动清除。</p>
      <p className="hint">手动清理始终作用于所有项目、所有环境，默认只清响应；不删除接口路径、参数、鉴权或域名配置。</p>
      <p className="hint">已有手动备份会保留，不受本次清理影响；备份中的数据不会被删除。</p>
      <label className="checkbox-label"><input type="checkbox" checked={clearRequestBodies} disabled={blocked || pending || !!model.confirmation} onChange={event => { setClearRequestBodies(event.target.checked); setFeedback(''); }} />同时清空请求正文和表单（全部环境配置及基础模板）</label>
      <div className="data-cleanup-actions"><button className="danger-text" disabled={blocked || pending || !!model.confirmation} onClick={() => void clean()}><Trash2 size={14} />清理数据</button>{pending && <span role="status">正在确认或清理…</span>}{model.hasRunning && <span>请求运行期间不可清理</span>}</div>
      {feedback && <p role={failed ? 'alert' : 'status'} className={failed ? 'danger-text' : 'hint'}>{feedback}</p>}
    </div>
  </section>;
}
