#!/bin/sh
# Prefer the optional project-local toolchain, otherwise use the system Rust.
set -eu
cd "$(dirname "$0")/.."
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-10.15}"
if [ -x "$PWD/.tools/cargo/bin/cargo" ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  # Prefer a complete bundled toolchain when rustup metadata is unavailable
  # (for example on a clean checkout copied from the release workspace).
  LOCAL_TOOLCHAIN="$RUSTUP_HOME/toolchains/stable-x86_64-apple-darwin"
  if [ -x "$LOCAL_TOOLCHAIN/bin/cargo" ]; then
    export PATH="$LOCAL_TOOLCHAIN/bin:$CARGO_HOME/bin:$PATH"
  else
    export PATH="$CARGO_HOME/bin:$PATH"
  fi
fi
case "${1:-dev}" in
  dev) exec npm exec -- tauri dev ;;
  build) exec npm exec -- tauri build --bundles app,dmg -- --locked ;;
  build-arm64) exec npm exec -- tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked ;;
  test) export RUST_TEST_THREADS="${RUST_TEST_THREADS:-1}"; exec cargo test --locked --manifest-path src-tauri/Cargo.toml ;;
  *) echo 'Usage: sh scripts/mac.sh [dev|build|build-arm64|test]' >&2; exit 2 ;;
esac
