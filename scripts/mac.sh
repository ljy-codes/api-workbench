#!/bin/sh
# Prefer the optional project-local toolchain, otherwise use the system Rust.
set -eu
cd "$(dirname "$0")/.."
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-10.15}"
if [ -x "$PWD/.tools/cargo/bin/cargo" ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
case "${1:-dev}" in
  dev) exec npm exec -- tauri dev ;;
  build) exec npm exec -- tauri build --bundles app,dmg ;;
  build-arm64) exec npm exec -- tauri build --target aarch64-apple-darwin --bundles app,dmg ;;
  test) exec cargo test --manifest-path src-tauri/Cargo.toml ;;
  *) echo 'Usage: sh scripts/mac.sh [dev|build|build-arm64|test]' >&2; exit 2 ;;
esac
