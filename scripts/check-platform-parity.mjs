import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Business source and brand assets have one owner: main. Platform adapters may
// differ, but their public behavior still needs native integration testing.
const sharedBuildConfig = ['tsconfig.json', 'vite.config.ts', 'index.html'];
const dependencySections = ['dependencies', 'devDependencies', 'overrides'];
const requiredShared = [
  ...sharedBuildConfig,
  'src/App.tsx', 'src/types.ts', 'src/lib/ipc.ts',
  'src-tauri/src/models.rs', 'src-tauri/src/engine.rs', 'src-tauri/src/store.rs',
  'src-tauri/migrations/001_initial.sql',
];
const requiredBrand = [
  'assets/brand/mark.svg', 'assets/brand/exports.json', 'scripts/generate-brand-assets.py',
  'public/envdock.svg', 'src-tauri/icons/icon.png',
  'src-tauri/icons/icon.ico', 'src-tauri/icons/icon.icns',
  'src-tauri/installer/header.bmp', 'src-tauri/installer/sidebar.bmp',
];
const adapters = new Map([
  ['src-tauri/src/lib.rs', '仅 data_directory() 后的路径与窗口启动实现可不同；前面的业务命令内容严格比较'],
  ['src-tauri/src/main.rs', '进程入口与系统错误展示'],
  ['src-tauri/src/secrets.rs', '操作系统秘密保护适配'],
  ['src-tauri/src/platform_paths.rs', 'macOS 系统目录别名与用户路径检查'],
  ['src-tauri/src/secrets_macos.rs', 'macOS Keychain 与测试密钥后端'],
  ['src-tauri/src/engine/upload.rs', '文件路径、符号链接和系统目录检查'],
  ['src-tauri/src/report_files.rs', '系统文件路径与原子保存'],
  ['scripts/mac.sh', 'macOS 工具链和构建入口'],
]);

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    maxBuffer: 32 * 1024 * 1024, ...options,
  });
}
function resolveCommit(repo, ref) {
  if (!ref || ref.startsWith('-') || /[\r\n\0]/.test(ref)) throw new Error(`Invalid Git ref: ${ref}`);
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
}
function isBrand(name) {
  return name.startsWith('assets/brand/') || name === 'public/envdock.svg'
    || name.startsWith('src-tauri/icons/')
    || ['src-tauri/installer/header.bmp', 'src-tauri/installer/sidebar.bmp', 'scripts/generate-brand-assets.py'].includes(name);
}
function isBusiness(name) {
  return name.startsWith('src/')
    || (name.startsWith('src-tauri/src/') && !adapters.has(name))
    || name.startsWith('src-tauri/migrations/')
    || sharedBuildConfig.includes(name)
    || ['scripts/check-platform-parity.mjs', 'scripts/check-version.mjs'].includes(name);
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
function readRevision(repo, ref) {
  const commit = resolveCommit(repo, ref);
  const files = new Map();
  for (const entry of git(repo, ['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
    const split = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, split).split(' ');
    if (type === 'blob') files.set(entry.slice(split + 1), { mode, oid });
  }
  const root = files.has('package.json') ? '' : files.has('开发空间/package.json') ? '开发空间/' : null;
  if (root === null) throw new Error(`${ref}: package.json is missing at the repository root and 开发空间/`);
  const normalized = new Map([...files].filter(([name]) => name.startsWith(root))
    .map(([name, value]) => [name.slice(root.length), value]));
  const missing = [...requiredShared, ...requiredBrand].filter(name => !normalized.has(name));
  const content = name => {
    const entry = normalized.get(name);
    return entry ? git(repo, ['cat-file', 'blob', entry.oid]) : null;
  };
  const packageJson = JSON.parse(content('package.json').toString('utf8'));
  const packageDependencies = Object.fromEntries(dependencySections.map(section => [section, canonicalize(packageJson[section] ?? {})]));
  const native = content('src-tauri/src/lib.rs')?.toString('utf8') ?? '';
  const registration = native.match(/tauri::generate_handler!\s*\[([^\]]*)\]/s)?.[1];
  const commands = registration ? registration.split(',').map(value => value.trim()).filter(Boolean).sort() : null;
  if (!commands?.length) missing.push('src-tauri/src/lib.rs: tauri::generate_handler!');
  const commandBoundary = native.search(/^\s*fn\s+data_directory\s*\(/m);
  const commandSourceSha256 = commandBoundary < 0 ? null : createHash('sha256').update(native.slice(0, commandBoundary)).digest('hex');
  if (commandBoundary < 0) missing.push('src-tauri/src/lib.rs: fn data_directory');
  else if (/#\[tauri::command(?:\([^)]*\))?\]/.test(native.slice(commandBoundary))) {
    missing.push('src-tauri/src/lib.rs: business commands must precede data_directory');
  }
  const brand = Object.fromEntries([...normalized].filter(([name]) => isBrand(name)).sort(([a], [b]) => a.localeCompare(b))
    .map(([name]) => [name, createHash('sha256').update(content(name)).digest('hex')]));
  return { ref, commit, root, normalized, missing, commands, brand, packageDependencies, commandSourceSha256 };
}
function difference(base, target, accept) {
  const names = new Set([...base.normalized.keys(), ...target.normalized.keys()]);
  return [...names].filter(accept).sort().flatMap(name => {
    const a = base.normalized.get(name), b = target.normalized.get(name);
    if (a?.oid === b?.oid && a?.mode === b?.mode) return [];
    return [{ path: name, reason: !a ? 'extra-on-target' : !b ? 'missing-on-target' : a.mode !== b.mode ? 'file-mode' : 'content' }];
  });
}
function publicRevision(value) {
  return { ref: value.ref, commit: value.commit, root: value.root || '.', missing: value.missing, brandSha256: value.brand, ipcCommands: value.commands, commandSourceSha256: value.commandSourceSha256, packageDependencies: value.packageDependencies };
}

export function inspectParity({ repo = process.cwd(), baseRef = 'main', targetRefs = ['windows', 'macos'] } = {}) {
  if (!targetRefs.length) throw new Error('At least one target Git ref is required.');
  const base = readRevision(repo, baseRef);
  const targets = targetRefs.map(ref => {
    const target = readRevision(repo, ref);
    const sharedDifferences = difference(base, target, isBusiness);
    if (base.commandSourceSha256 !== target.commandSourceSha256) {
      sharedDifferences.push({ path: 'src-tauri/src/lib.rs', reason: 'business-command-content' });
    }
    const brandDifferences = difference(base, target, isBrand);
    const platformDifferences = difference(base, target, name => adapters.has(name))
      .map(item => ({ ...item, reasonForException: adapters.get(item.path) }));
    const ipcEqual = JSON.stringify(base.commands) === JSON.stringify(target.commands);
    const dependencyDifferences = dependencySections.filter(section => JSON.stringify(base.packageDependencies[section]) !== JSON.stringify(target.packageDependencies[section]));
    return {
      ...publicRevision(target), sharedDifferences, brandDifferences, platformDifferences, ipcEqual, dependencyDifferences,
      ok: !base.missing.length && !target.missing.length && !sharedDifferences.length && !brandDifferences.length && ipcEqual && !dependencyDifferences.length,
    };
  });
  return {
    ok: !base.missing.length && targets.every(target => target.ok),
    base: publicRevision(base), targets,
    limitations: [
      '逐文件比较共享源码、测试、数据库迁移、前端构建配置及 lib.rs 中 data_directory() 之前的业务命令内容；比较 npm 依赖与 overrides；品牌文件输出 SHA-256。',
      '系统适配文件的实现差异单独报告，不据此要求系统 API 相同。',
      '代码一致不能代替 macOS / Windows 上的编译、安装、启动、窗口、密钥和文件操作验收。',
    ],
  };
}

function parseArgs(args) {
  const result = { repo: process.cwd(), baseRef: 'main', targetRefs: ['windows', 'macos'], json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') result.json = true;
    else if (['--base', '--targets', '--repo'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--base') result.baseRef = value;
      else if (arg === '--targets') result.targetRefs = value.split(',').map(item => item.trim()).filter(Boolean);
      else result.repo = value;
    } else if (arg === '--help') return null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}
function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      console.log('Usage: node scripts/check-platform-parity.mjs [--base main] [--targets windows,macos] [--repo PATH] [--json]');
      return;
    }
    const report = inspectParity(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Shared baseline: ${report.base.ref} (${report.base.commit.slice(0, 12)})`);
      for (const target of report.targets) {
        console.log(`${target.ok ? 'PASS' : 'FAIL'} ${target.ref}: shared=${target.sharedDifferences.length}, brand=${target.brandDifferences.length}, IPC=${target.ipcEqual ? 'same' : 'different'}, dependencies=${target.dependencyDifferences.length}, platform adapters=${target.platformDifferences.length}`);
        for (const name of [...report.base.missing, ...target.missing]) console.log(`  missing required: ${name}`);
        for (const item of [...target.sharedDifferences, ...target.brandDifferences]) console.log(`  ${item.reason}: ${item.path}`);
        for (const section of target.dependencyDifferences) console.log(`  package.json dependency drift: ${section}`);
        for (const item of target.platformDifferences) console.log(`  allowed platform adapter: ${item.path}`);
      }
      console.log('Native builds and installation/startup verification are required on each target OS.');
    }
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Platform parity check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
