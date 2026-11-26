import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectParity } from './check-platform-parity.mjs';

const native = (body = '1', startup = '') => `
#[tauri::command]
fn load_workspace() {}
#[tauri::command]
fn send_request() { ${body} }
fn data_directory() { ${startup} }
fn run() { tauri::generate_handler![load_workspace, send_request] }`;


function fixture(t, legacy = false) {
  const repo = mkdtempSync(path.join(tmpdir(), 'envdock-parity-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'EnvDock test');
  git('config', 'user.email', 'test@example.invalid');
  const files = [
    'assets/brand/mark.svg', 'assets/brand/exports.json', 'scripts/generate-brand-assets.py',
    'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/App.tsx', 'src/types.ts', 'src/lib/ipc.ts',
    'src-tauri/src/models.rs', 'src-tauri/src/engine.rs', 'src-tauri/src/store.rs',
    'src-tauri/src/engine/upload.rs', 'src-tauri/migrations/001_initial.sql',
    'public/envdock.svg', 'src-tauri/icons/icon.png', 'src-tauri/icons/icon.ico',
    'src-tauri/icons/icon.icns', 'src-tauri/installer/header.bmp', 'src-tauri/installer/sidebar.bmp',
  ];
  const write = (name, content, prefix = '') => {
    const target = path.join(repo, prefix, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const name of files) write(name, `${name}\n`);
  write('package.json', JSON.stringify({ version: '2.0.2', dependencies: { react: '^19' }, devDependencies: { vite: '^7' }, overrides: { nested: { child: '^1' } } }));
  write('src-tauri/src/lib.rs', native());
  git('add', '.'); git('commit', '-m', 'baseline');
  git('branch', 'windows'); git('branch', 'macos');
  if (legacy) {
    git('switch', 'macos');
    mkdirSync(path.join(repo, '开发空间'));
    for (const name of ['assets', 'scripts', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src', 'src-tauri', 'public']) git('mv', name, `开发空间/${name}`);
    git('commit', '-m', 'legacy directory');
    git('switch', 'main');
  }
  const commit = (branch, name, content) => {
    git('switch', branch); write(name, content, legacy && branch === 'macos' ? '开发空间' : '');
    git('add', '.'); git('commit', '-m', 'change'); git('switch', 'main');
  };
  return { repo, commit };
}

test('matches shared and brand contents across root and legacy directory layouts', t => {
  const { repo } = fixture(t, true);
  const report = inspectParity({ repo });
  assert.equal(report.ok, true);
  assert.equal(report.targets[1].root, '开发空间/');
  assert.match(report.base.brandSha256['public/envdock.svg'], /^[a-f0-9]{64}$/);
});

test('detects changed business content even when the file still exists', t => {
  const { repo, commit } = fixture(t);
  commit('windows', 'src/App.tsx', 'platform omitted a feature');
  const report = inspectParity({ repo });
  assert.equal(report.ok, false);
  assert.deepEqual(report.targets[0].sharedDifferences, [{ path: 'src/App.tsx', reason: 'content' }]);
});

test('detects different generated icon bytes', t => {
  const { repo, commit } = fixture(t);
  commit('macos', 'src-tauri/icons/icon.icns', Buffer.from([0, 12, 255]));
  const report = inspectParity({ repo });
  assert.equal(report.ok, false);
  assert.deepEqual(report.targets[1].brandDifferences, [{ path: 'src-tauri/icons/icon.icns', reason: 'content' }]);
});

test('allows documented system adapters but requires the same IPC commands', t => {
  const { repo, commit } = fixture(t);
  commit('macos', 'src-tauri/src/engine/upload.rs', 'macOS system aliases and file validation');
  let report = inspectParity({ repo });
  assert.equal(report.ok, true);
  assert.equal(report.targets[1].platformDifferences.length, 1);
  commit('macos', 'src-tauri/src/lib.rs', 'fn run() { tauri::generate_handler![load_workspace] }');
  report = inspectParity({ repo });
  assert.equal(report.ok, false);
  assert.equal(report.targets[1].ipcEqual, false);
});

test('rejects incomplete repositories rather than passing an empty comparison', t => {
  const { repo, commit } = fixture(t);
  commit('macos', 'src-tauri/src/lib.rs', '// no command registration');
  const report = inspectParity({ repo });
  assert.equal(report.ok, false);
  assert.ok(report.targets[1].missing.includes('src-tauri/src/lib.rs: tauri::generate_handler!'));
});


test('checks build inputs and dependency drift while allowing version and platform script changes', t => {
  const { repo, commit } = fixture(t);
  const metadata = {
    version: '2.0.3', scripts: { desktop: 'powershell platform-entry.ps1' },
    // Different property order has no semantic effect.
    overrides: { nested: { child: '^1' } }, devDependencies: { vite: '^7' }, dependencies: { react: '^19' },
  };
  commit('windows', 'package.json', JSON.stringify(metadata));
  assert.equal(inspectParity({ repo }).ok, true);
  for (const [section, value] of [
    ['dependencies', { react: '^20' }],
    ['devDependencies', { vite: '^8' }],
    ['overrides', { nested: { child: '^2' } }],
  ]) {
    commit('windows', 'package.json', JSON.stringify({ ...metadata, [section]: value }));
    const report = inspectParity({ repo });
    assert.equal(report.ok, false);
    assert.deepEqual(report.targets[0].dependencyDifferences, [section]);
  }
  for (const name of ['tsconfig.json', 'vite.config.ts', 'index.html']) {
    commit('macos', name, 'different build input');
    assert.ok(inspectParity({ repo }).targets[1].sharedDifferences.some(item => item.path === name));
  }
});


test('rejects a changed command body with unchanged IPC names and permits startup adapters', t => {
  const { repo, commit } = fixture(t);
  commit('macos', 'src-tauri/src/lib.rs', native('1', 'macos_paths()'));
  let report = inspectParity({ repo });
  assert.equal(report.ok, true);
  commit('macos', 'src-tauri/src/lib.rs', native('2', 'macos_paths()'));
  report = inspectParity({ repo });
  assert.equal(report.ok, false);
  assert.equal(report.targets[1].ipcEqual, true);
  assert.deepEqual(report.targets[1].sharedDifferences, [{ path: 'src-tauri/src/lib.rs', reason: 'business-command-content' }]);
});
