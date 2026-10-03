import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig, FormField } from '../types';
import { AuthEditor } from './AuthEditor';
import { FormEditor } from './FormEditor';
import { ResizeHandle } from './ResizeHandle';
import { Sidebar } from './Sidebar';
import { demoWorkspace, newRequest } from '../lib/workspace';

afterEach(cleanup);
describe('0.2 编辑控件', () => {
  it.each([
    ['bearer', 'token', 'Token 变量引用'],
    ['basic', 'password', '密码变量引用'],
    ['apiKey', 'value', 'API Key 变量引用'],
  ] as const)('%s：外部 prop 更新同 kind 凭据引用时不显示旧引用', (kind, field, label) => {
    const onChange = vi.fn();
    const { rerender } = render(<AuthEditor value={{ kind, [field]: '{{before}}' }} onChange={onChange} />);
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('{{before}}');
    rerender(<AuthEditor value={{ kind, [field]: '{{after}}' }} onChange={onChange} />);
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('{{after}}');
    rerender(<AuthEditor value={{ kind, [field]: '' }} onChange={onChange} />);
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('无关 prop 更新不清空无效草稿；外部引用变更显示新值并允许恢复未完成输入', () => {
    const onChange = vi.fn();
    const { rerender } = render(<AuthEditor value={{ kind: 'basic', username: 'before', password: '{{saved}}' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('密码变量引用'), { target: { value: '{{unfinished' } });
    rerender(<AuthEditor value={{ kind: 'basic', username: 'after', password: '{{saved}}' }} onChange={onChange} />);
    expect((screen.getByLabelText('密码变量引用') as HTMLInputElement).value).toBe('{{unfinished');
    expect((screen.getByLabelText('鉴权用户名') as HTMLInputElement).value).toBe('after');
    rerender(<AuthEditor value={{ kind: 'basic', username: 'after', password: '{{external}}' }} onChange={onChange} />);
    expect((screen.getByLabelText('密码变量引用') as HTMLInputElement).value).toBe('{{external}}');
    fireEvent.click(screen.getByRole('button', { name: '恢复未完成输入' }));
    expect((screen.getByLabelText('密码变量引用') as HTMLInputElement).value).toBe('{{unfinished');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('密码变量引用'), { target: { value: '{{finished}}' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'basic', username: 'after', password: '{{finished}}' });
  });
  it.each(['', '{{ token }}', '{{中文 变量}}', '{{ token\u00a0}}'])('与后端一致接受引用 %j', token => {
    const onChange = vi.fn();
    render(<AuthEditor value={{ kind: 'bearer', token: '{{old}}' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Token 变量引用'), { target: { value: token } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'bearer', token });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each(['{{ }}', '{{}}', '{{a{b}}', '{{token}} tail', ' {{token}}', '{{a\u0085b}}'])('与后端一致拒绝无效引用 %j，不写回工作区', token => {
    const onChange = vi.fn();
    render(<AuthEditor value={{ kind: 'bearer', token: '{{old}}' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Token 变量引用'), { target: { value: token } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('鉴权仅提交空值或变量引用，拒绝明文秘密，支持显式不继承', () => {
    function Harness() {
      const [auth, setAuth] = useState<AuthConfig | null>({ kind: 'bearer', token: '' });
      return <><AuthEditor value={auth} onChange={setAuth} inherited /><output data-testid="auth">{JSON.stringify(auth)}</output></>;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Token 变量引用'), { target: { value: 'plaintext-secret' } });
    expect(screen.getByTestId('auth').textContent).not.toContain('plaintext-secret');
    expect(screen.getByRole('alert').textContent).toContain('变量引用');
    fireEvent.change(screen.getByLabelText('Token 变量引用'), { target: { value: '{{token}}' } });
    expect(screen.getByTestId('auth').textContent).toContain('{{token}}');
    fireEvent.change(screen.getByLabelText('鉴权方式'), { target: { value: 'none' } });
    expect(screen.getByTestId('auth').textContent).toBe('{"kind":"none"}');
    fireEvent.change(screen.getByLabelText('鉴权方式'), { target: { value: 'inherit' } });
    expect(screen.getByTestId('auth').textContent).toBe('null');
  });
  it('multipart 文件选择调用原生选择器并保留返回路径', async () => {
    const pickFile = vi.fn().mockResolvedValue('C:\\sample.txt');
    function Harness() {
      const [value, setValue] = useState<FormField[]>([{ id: 'f', key: 'file', value: '', enabled: true, kind: 'file' }]);
      return <FormEditor value={value} multipart onChange={setValue} pickFile={pickFile} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '选择文件1' }));
    expect(await screen.findByDisplayValue('C:\\sample.txt')).toBeTruthy();
    expect(pickFile).toHaveBeenCalledTimes(1);
  });
  it('分隔条支持方向键和 Home/End 并遵守尺寸上下界', () => {
    function Harness() {
      const [value, onChange] = useState(260);
      return <ResizeHandle label="侧栏宽度" value={value} min={200} max={400} onChange={onChange} orientation="vertical" />;
    }
    render(<Harness />);
    const separator = screen.getByRole('separator', { name: '侧栏宽度' });
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator.getAttribute('aria-valuenow')).toBe('400');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('400');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('200');
  });
  it.each(['用户服务', 'POST', '/users', '创建用户'])('搜索 %s 只展示当前项目匹配的接口', term => {
    const workspace = demoWorkspace();
    workspace.services.push({ id: 'other', name: '用户服务', projectId: 'other' });
    workspace.requests.push({ ...newRequest('other', null, 'other-request'), name: '其他项目私有接口', path: '/users', method: 'POST' });
    render(<Sidebar workspace={workspace} selectedId={null} onSelect={vi.fn()} onManage={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('搜索接口'), { target: { value: term } });
    expect(screen.getByRole('button', { name: /创建用户/ })).toBeTruthy();
    expect(screen.queryByText('其他项目私有接口')).toBeNull();
  });
});
