# Installer maintenance

`envdock.nsi` is based on the Tauri `tauri-cli-v2.11.5` template:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.5/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

Upstream is MIT OR Apache-2.0; the MIT license is included in `TAURI-LICENSE-MIT`.
Keep the template pinned and inspect upstream changes whenever updating the CLI.

Local changes:
- EnvDock MUI colors, fonts, brand bitmaps and localized feature summary.
- Original, source-built x86 `EnvDockTheme` plugin for documented Win32 painting APIs.
- Explicit uninstall data selection and irreversible confirmation.
- Exact argv parsing (`GetOptions` prefix matching is unsafe for destructive flags).
- Full cleanup before removing the program/registration, with a checked exit code.
- Uninstall-before-upgrade uses `/UPDATE`; it must always retain data.
- Product registration removed when uninstalling, even if preserving the workspace.
- WebView2 preparation uses the source-controlled PowerShell helper with bounded
  official bootstrapper/standalone attempts, Authenticode verification and
  post-install detection, including `/UPDATE`.
- Wizard upgrade removal is deferred until the prerequisite section succeeds.
  Script failure is never permission to continue writing the new payload.

The generated `plugins` directory is ignored by Git. Always build via
`scripts/build-installer.ps1`; it compiles the theme first and verifies fresh output.
Native dialog controls retain their accessibility/input behavior; system-owned
file dialogs, security dialogs and message boxes are not forcibly skinned.

Data cleanup is bounded by fixed special-folder roots. Never add wildcard searches
for backup directories, never recursively remove `$INSTDIR`, and never make
`/S` alone destructive. External migration recovery copies deliberately remain.
