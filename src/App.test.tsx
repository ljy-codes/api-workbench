import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';

vi.mock('@uiw/react-codemirror', () => ({ default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => <textarea aria-label="代码编辑器" value={value} onChange={e => onChange?.(e.target.value)} /> }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);
describe('中文工作台浏览器预览', () => {
  it('明确仅内存预览且没有伪造响应', () => {
    render(<App />);
    expect(screen.getByText('EnvDock')).toBeTruthy();
    expect(screen.getByText('仅内存预览，桌面版才可保存和发送')).toBeTruthy();
    expect(screen.getByRole('button', { name: '载入内存示例' })).toBeTruthy();
    expect(screen.queryByText('200 OK')).toBeNull();
  });
  it('加载示例、编辑 Query，预览模式切换接口保留内存草稿且不弹旧确认', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '载入内存示例' }));
    fireEvent.change(screen.getByLabelText('参数值1'), { target: { value: '2' } });
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: /创建用户/ }));
    expect(screen.queryByRole('dialog', { name: '有尚未保存的修改' })).toBeNull();
    expect(await screen.findByDisplayValue('/users')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: /获取用户列表/ }));
    expect((await screen.findByLabelText('参数值1') as HTMLInputElement).value).toBe('2');
  });
  it('创建、修改项目与删除关联确认真实可用', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '创建第一个项目' }));
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建项目' });
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '测试项目' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '应用到工作区' }));
    expect(screen.getByRole('button', { name: '编辑项目 测试项目' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '编辑项目 测试项目' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '更新后的项目' } });
    fireEvent.click(screen.getByRole('button', { name: '应用到工作区' }));
    fireEvent.click(screen.getByRole('button', { name: '删除项目 更新后的项目' }));
    expect(await screen.findByText(/将关联删除：1 个项目/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认关联删除' }));
    expect(await screen.findByText('暂无项目')).toBeTruthy();
  });
  it('六层变量编辑默认遮罩秘密值，可以删除', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '载入内存示例' }));
    fireEvent.click(screen.getByRole('tab', { name: '变量' }));
    expect(screen.getByRole('tab', { name: /本次临时/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加变量' }));
    fireEvent.change(screen.getByLabelText('变量名'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('token的值'), { target: { value: 'sensitive' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '秘密' }));
    expect((screen.getByLabelText('token的值') as HTMLInputElement).type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: '删除变量 token' }));
    expect(screen.queryByLabelText('token的值')).toBeNull();
  });
});
