import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

test('project MIT license matches package metadata and preserves third-party ownership', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) 2026 ljy-codes/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.equal(JSON.parse(read('package.json')).license, 'MIT');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].license, 'MIT');
  assert.match(read('src-tauri/Cargo.toml'), /^license = "MIT"$/m);
  assert.match(read('src-tauri/installer/TAURI-LICENSE-MIT'), /Tauri Apps Contributors/);
});

test('installer and portable delivery directories include the project license', () => {
  for (const path of ['scripts/build-installer.ps1', 'scripts/build-preview.ps1']) {
    assert.ok(read(path).includes("Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $output 'LICENSE.txt')"));
  }
});

test('EnvDock current-user NSIS distribution retains identity without native decorations', () => {
  assert.equal(config.productName, 'EnvDock');
  assert.equal(config.mainBinaryName, 'EnvDock');
  assert.equal(config.identifier, 'local.apiworkbench.desktop');
  assert.equal(config.app.windows[0].title, '');
  assert.equal(config.app.windows[0].decorations, false);
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ['nsis']);
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.equal(config.bundle.windows.nsis.installerHooks, 'installer-hooks.nsh');
  assert.deepEqual(config.bundle.windows.nsis.languages, ['SimpChinese', 'English']);
});

test('custom desktop chrome has the window permissions it invokes', () => {
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
  for (const permission of [
    'core:window:allow-close',
    'core:window:allow-minimize',
    'core:window:allow-toggle-maximize',
    'core:window:allow-start-dragging',
  ]) {
    assert.ok(capability.permissions.includes(permission), `missing ${permission}`);
  }
});

test('main window is created by the startup recovery path', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.app.windows[0].label, 'main');
  assert.equal(config.app.windows[0].create, false);
});

test('downgrade guard runs before interactive uninstall and before silent overwrite', () => {
  const hooks = read('src-tauri/installer-hooks.nsh');
  assert.match(hooks, /MUI_CUSTOMFUNCTION_GUIINIT EnvDockCheckInstalledVersion/);
  assert.match(hooks, /!macro NSIS_HOOK_PREINSTALL\s+Call EnvDockCheckInstalledVersion/);
  assert.ok(hooks.includes('ReadRegStr $0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EnvDock" "DisplayVersion"'));
  assert.ok(hooks.includes('${GetFileVersion} "$EXEPATH" $1'));
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.match(hooks, /SetErrorLevel 1638\s+Quit/);
});

test('installer contains no bundled user files or sidecars', () => {
  assert.ok(!config.bundle.resources?.length);
  assert.ok(!config.bundle.externalBin?.length);
  assert.equal(config.bundle.createUpdaterArtifacts ?? false, false);
});

test('version and storage paths remain compatible', () => {
  assert.equal(config.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, config.version);
  assert.equal(lock.packages[''].version, config.version);
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`version = "${config.version.replaceAll('.', '\\.')}"`));
  assert.match(read('src-tauri/Cargo.lock'), new RegExp(`name = "api-workbench"\\s+version = "${config.version.replaceAll('.', '\\.')}"`));
  const native = read('src-tauri/src/lib.rs');
  assert.match(native, /join\("ApiWorkbench"\)/);
  assert.match(native, /join\("ApiWorkbenchData"\)/);
});

test('all platform icon exports match the shared paired-chambers brand master', () => {
  const manifest = JSON.parse(read('assets/brand/exports.json'));
  const master = readFileSync(new URL(manifest.master, root));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.identity, 'paired-chambers-b');
  assert.equal(digest(master), manifest.masterSha256);
  assert.deepEqual(readFileSync(new URL('public/envdock.svg', root)), master);
  assert.match(master.toString(), /viewBox="0 0 256 256"/);
  assert.match(master.toString(), /#F3E9DC/);
  assert.match(master.toString(), /#FB923C/);
  assert.doesNotMatch(master.toString(), /#39E0D0|#438FFF/i);
  for (const path of [
    'public/envdock.svg', 'src-tauri/icons/icon.png', 'src-tauri/icons/icon.ico',
    'src-tauri/icons/icon.icns', 'src-tauri/installer/header.bmp', 'src-tauri/installer/sidebar.bmp',
  ]) {
    assert.equal(digest(readFileSync(new URL(path, root))), manifest.files[path], `${path} is stale`);
  }
});

test('desktop icons include correct PNG, ICO and macOS ICNS image sizes', () => {
  const png = readFileSync(new URL('src-tauri/icons/icon.png', root));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 256);
  assert.equal(png.readUInt32BE(20), 256);
  const ico = readFileSync(new URL('src-tauri/icons/icon.ico', root));
  assert.deepEqual(Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + 16 * index] || 256), [16, 24, 32, 48, 64, 128, 256]);
  const icns = readFileSync(new URL('src-tauri/icons/icon.icns', root));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const sizes = [];
  for (let offset = 8; offset < icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= icns.length);
    const image = icns.subarray(offset + 8, offset + length);
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.equal(image.readUInt32BE(16), image.readUInt32BE(20));
    sizes.push(image.readUInt32BE(16));
    offset += length;
  }
  assert.deepEqual(sizes, [16, 32, 64, 128, 256, 512, 1024]);
});

test('macOS bundle uses the shared ICNS master export and stable application identity', () => {
  const mac = JSON.parse(read('src-tauri/tauri.macos.conf.json'));
  assert.deepEqual(mac.bundle.targets, ['app', 'dmg']);
  assert.deepEqual(mac.bundle.icon, ['icons/icon.icns']);
  assert.equal(mac.bundle.macOS.minimumSystemVersion, '10.15');
  assert.equal(mac.bundle.macOS.signingIdentity, '-');
  assert.deepEqual(mac.bundle.resources, { '../LICENSE': 'LICENSE.txt', '../public/third-party-notices.txt': 'THIRD-PARTY-LICENSE-YAML.txt' });
  assert.equal(config.identifier, 'local.apiworkbench.desktop');
});

test('release installer and portable builds have separate feature selections', () => {
  const installer = read('scripts/build-installer.ps1');
  assert.match(installer, /--bundles nsis/);
  assert.doesNotMatch(installer, /--features portable/);
  assert.match(installer, /--locked/);
  assert.match(read('scripts/build-preview.ps1'), /--features portable,custom-protocol/);
});

test('dark installer and uninstaller share original EnvDock branding', () => {
  const nsis = config.bundle.windows.nsis;
  assert.equal(nsis.template, 'installer/envdock.nsi');
  assert.equal(nsis.installerIcon, 'icons/icon.ico');
  assert.equal(nsis.uninstallerIcon, 'icons/icon.ico');
  const ico = readFileSync(new URL('src-tauri/icons/icon.ico', root));
  assert.ok(ico.readUInt16LE(4) >= 7, 'icon needs 16 through 256 px variants');
  const template = read('src-tauri/installer/envdock.nsi');
  assert.match(template, /MUI_BGCOLOR "0B111B"/);
  assert.match(template, /SetFont \/LANG=2052 "Microsoft YaHei UI" 9/);
  assert.match(template, /EnvDockTheme::Apply/);
  assert.match(template, /MUI_UNWELCOMEFINISHPAGE_BITMAP/);
  assert.match(read('src-tauri/installer/messages.nsh'), /多项目.*多服务.*多环境/);
  assert.match(read('src-tauri/installer/messages.nsh'), /Ctrl\+S/);
  assert.match(read('src/App.tsx'), /src="\/envdock\.svg"/);
});

test('complete uninstall is explicit, upgrade protected and checked before binary deletion', () => {
  const template = read('src-tauri/installer/envdock.nsi');
  const uninstall = template.slice(template.indexOf('Section Uninstall'));
  assert.ok(uninstall.indexOf('Call un.EnvDockCleanData') < uninstall.indexOf('Delete "$INSTDIR\\${MAINBINARYNAME}.exe"'));
  assert.doesNotMatch(uninstall, /RmDir \/r "\$(?:LOCALAPPDATA|APPDATA)/i);
  assert.match(template, /StrCpy \$R1 "\$R1 \/UPDATE"/);
  const cleanup = read('src-tauri/installer/cleanup.nsh');
  assert.match(cleanup, /\$UpdateMode = 1/);
  assert.match(cleanup, /\/PURGE/);
  assert.match(cleanup, /SetErrorLevel 5/);
  assert.match(cleanup, /MB_DEFBUTTON2/);
});

test('runtime preparation precedes deferred upgrade removal and payload installation', () => {
  const template = read('src-tauri/installer/envdock.nsi');
  const dependencies = template.slice(template.indexOf('Section WebView2'), template.indexOf('Section Install'));
  assert.match(dependencies, /Call EnvDockEnsureDependencies/);
  assert.ok(dependencies.indexOf('Call EnvDockEnsureDependencies') < dependencies.indexOf('Call EnvDockUninstallPrevious'));
  assert.doesNotMatch(dependencies, /UpdateMode.*(?:<>|!=).*1/);
  const leave = template.slice(template.indexOf('Function PageLeaveReinstall'), template.indexOf('Function EnvDockUninstallPrevious'));
  assert.match(leave, /StrCpy \$EnvDockPendingUninstall 1/);
  assert.match(leave, /StrCpy \$EnvDockPreviousInstallDirectory \$INSTDIR/);
  assert.doesNotMatch(leave, /ExecWait/);
  const removal = template.slice(template.indexOf('Function EnvDockUninstallPrevious'), template.indexOf('; 5. Choose install directory page'));
  assert.match(removal, /FileExists.*\$EnvDockUninstallDirectory/);
  assert.doesNotMatch(removal, /FileExists.*"\$INSTDIR/);
  assert.match(template, /Section EarlyChecks\s+Call EnvDockCheckInstalledVersion/);
});

test('dependency failures cannot silently continue and downloads never use NSISdl', () => {
  const helper = read('src-tauri/installer/dependencies.nsh');
  assert.match(helper, /nsExec::ExecToLog/);
  assert.match(helper, /ensure-webview2\.ps1/);
  assert.match(helper, /-WorkDirectory/);
  assert.match(helper, /SetErrorLevel 1603/);
  assert.match(helper, /SetErrorLevel 3010/);
  assert.match(helper, /SetErrorLevel 1460/);
  assert.match(helper, /Abort/);
  assert.match(helper, /\$\{Silent\}/);
  assert.match(helper, /\$PassiveMode = 1/);
  assert.doesNotMatch(read('src-tauri/installer/envdock.nsi'), /NSISdl::download/);
});
