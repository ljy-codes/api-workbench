import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorState, EditorView } from '@uiw/react-codemirror';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Preview, Workspace } from '../types';
import { api } from '../lib/ipc';
import { demoWorkspace } from '../lib/workspace';
import { useWorkbench } from '../hooks/useWorkbench';
import { RequestEditor } from './RequestEditor';

// Only IPC is mocked: exercise the actual CodeMirror DOM, commands and React wrapper.
vi.mock('../lib/ipc', () => ({
  desktop: true,
  api: { load: vi.fn(), save: vi.fn(), preview: vi.fn(), send: vi.fn(), cancel: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Harness() {
  const model = useWorkbench();
  return <>
    <fieldset disabled={model.busy}><RequestEditor model={model} /></fieldset>
    <output data-testid="draft">{model.request?.body}</output>
    <output data-testid="dirty">{String(model.dirty)}</output>
    <output data-testid="revision">{model.workspace.revision}</output>
    <output data-testid="notice">{model.notice}</output>
  </>;
}

const rangeMethods = ['getClientRects', 'getBoundingClientRect'] as const;
const originalRangeDescriptors = rangeMethods.map(name => Object.getOwnPropertyDescriptor(Range.prototype, name));
beforeAll(() => {
  // jsdom has no text layout. Supply only geometry APIs, not editor/input behavior.
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => document.createElement('span').getClientRects() },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
  });
});
afterAll(() => {
  rangeMethods.forEach((name, index) => {
    const original = originalRangeDescriptors[index];
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  const workspace = demoWorkspace();
  workspace.requests[0] = { ...workspace.requests[0], bodyType: 'text', body: 'saved body' };
  vi.mocked(api.load).mockResolvedValue(workspace);
});
afterEach(cleanup);

async function openBody() {
  const { container } = render(<Harness />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Body' }));
  let content!: HTMLElement;
  await waitFor(() => {
    content = container.querySelector<HTMLElement>('.cm-content')!;
    expect(content).not.toBeNull();
  });
  const view = EditorView.findFromDOM(content)!;
  expect(view).toBeTruthy();
  return { content, view };
}

function pressEnter(view: EditorView) {
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });
  fireEvent.keyDown(view.contentDOM, { key: 'Enter', code: 'Enter' });
}

describe('真实正文编辑器的异步锁定', () => {
  it.each(['成功', '失败'] as const)('延迟保存%s：等待期间禁止正文编辑，结束后恢复编辑能力', async outcome => {
    const pending = deferred<Workspace>();
    vi.mocked(api.save).mockReturnValueOnce(pending.promise);
    const { view, content } = await openBody();
    expect(content.getAttribute('contenteditable')).toBe('true');
    pressEnter(view);
    const draft = view.state.doc.toString();
    expect(draft).toBe('saved body\n');
    expect(screen.getByTestId('draft').textContent).toBe(draft);
    expect(screen.getByTestId('dirty').textContent).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '保存工作区' }));
    expect(api.save).toHaveBeenCalledTimes(1);
    const snapshot = structuredClone(vi.mocked(api.save).mock.calls[0][0]);
    expect(snapshot.requests[0].body).toBe(draft);

    // fieldset disabled alone does not stop CodeMirror's actual editing command.
    pressEnter(view);
    expect(view.state.doc.toString()).toBe(draft);
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(content.getAttribute('contenteditable')).toBe('false');
    expect(screen.getByTestId('draft').textContent).toBe(draft);

    await act(async () => {
      if (outcome === '成功') pending.resolve({ ...snapshot, revision: snapshot.revision + 1 });
      else pending.reject('测试保存失败');
    });
    expect(view.state.doc.toString()).toBe(draft);
    expect(screen.getByTestId('dirty').textContent).toBe(String(outcome === '失败'));
    expect(screen.getByTestId('revision').textContent).toBe(outcome === '成功' ? '1' : '0');
    expect(content.getAttribute('contenteditable')).toBe('true');
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe(`${draft}\n`);
    expect(screen.getByTestId('draft').textContent).toBe(`${draft}\n`);
    expect(screen.getByTestId('dirty').textContent).toBe('true');
  });

  it('脱敏预览等其他 busy 阶段同样锁定正文，结束后不遗留只读状态', async () => {
    const pending = deferred<Preview>();
    vi.mocked(api.preview).mockReturnValueOnce(pending.promise);
    const { view, content } = await openBody();
    fireEvent.click(screen.getByRole('button', { name: '脱敏预览' }));
    expect(api.preview).toHaveBeenCalledTimes(1);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe('saved body');
    expect(content.getAttribute('contenteditable')).toBe('false');
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    await act(async () => {
      pending.resolve({ url: 'https://api.example.com/users', environmentName: '开发环境', serviceName: '用户服务', isProduction: false, resolvedVariables: [] });
    });
    expect(content.getAttribute('contenteditable')).toBe('true');
    expect(view.state.facet(EditorState.readOnly)).toBe(false);
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });
});
