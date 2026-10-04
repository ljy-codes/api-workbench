import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

test('EnvDock current-user NSIS distribution retains the existing app identity', () => {
  assert.equal(config.productName, 'EnvDock');
  assert.equal(config.mainBinaryName, 'EnvDock');
  assert.equal(config.identifier, 'local.apiworkbench.desktop');
  assert.equal(config.app.windows[0].title, 'EnvDock · API Workbench');
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ['nsis']);
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser');
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.equal(config.bundle.windows.nsis.installerHooks, 'installer-hooks.nsh');
  assert.deepEqual(config.bundle.windows.nsis.languages, ['SimpChinese', 'English']);
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
  assert.match(read('src-tauri/Cargo.toml'), new RegExp(`version = "${config.version.replaceAll('.', '\\.')}"`));
  const native = read('src-tauri/src/lib.rs');
  assert.match(native, /join\("ApiWorkbench"\)/);
  assert.match(native, /join\("ApiWorkbenchData"\)/);
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
