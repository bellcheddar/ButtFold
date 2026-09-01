#!/usr/bin/env bash
# Build the Gō model for the browser. PLAN.md section 5.4, both milestones.
#
#   ./tools/build_wasm.sh cli       milestone 1: the CLI compiled untouched, against MEMFS.
#                                   Proves the toolchain and feeds the P0-3 parity test.
#                                   Nothing new is written in C to get this.
#   ./tools/build_wasm.sh module    milestone 2: the streaming module the worker drives,
#                                   go_model_fold.c plus the additive wasm_api.c.
#   ./tools/build_wasm.sh           both.
#
# The emsdk version is pinned. An unpinned toolchain is a build that changes underneath a
# measured number, and every number here is measured.
set -euo pipefail

EMSDK_VERSION=4.0.7
EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [[ ! -d "$EMSDK_DIR" ]]; then
  echo "emsdk not found at $EMSDK_DIR." >&2
  echo "  git clone https://github.com/emscripten-core/emsdk.git $EMSDK_DIR" >&2
  echo "  cd $EMSDK_DIR && ./emsdk install $EMSDK_VERSION && ./emsdk activate $EMSDK_VERSION" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1

have=$(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/')
if [[ "$have" != "$EMSDK_VERSION" ]]; then
  echo "emcc is $have, this project pins $EMSDK_VERSION. Refusing to build." >&2
  exit 1
fi

target="${1:-all}"
mkdir -p build/wasm static/wasm

build_cli () {
  echo "==> milestone 1: the CLI, untouched, on MEMFS"
  # NODERAWFS lets the same binary run under node against the real filesystem, which is what
  # the P0-3 parity test needs: identical argv, identical input files, one comparison.
  emcc -O3 native/go_model_fold.c -o build/wasm/go_model_cli.js \
    -lm \
    -s NODERAWFS=1 \
    -s ENVIRONMENT=node \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXIT_RUNTIME=1
  echo "    build/wasm/go_model_cli.js  $(du -h build/wasm/go_model_cli.wasm | cut -f1) wasm"
}

build_module () {
  echo "==> milestone 2: the streaming module"
  # Only wasm_api.c is compiled: it #includes go_model_fold.c, because everything the
  # wrapper needs in there is `static` and there is nothing to link against. Naming both
  # files here would be a duplicate-symbol error.
  # EXPORT_ES6, and therefore a .mjs: MODULARIZE alone emits a UMD factory with no ES
  # `export default`, so `import createGoModel from ...` throws in a browser. The node test
  # did NOT catch this, because node happily loaded the same file as CommonJS and found the
  # factory on module.exports. One artefact, two loaders, one of them lying.
  emcc -O3 native/wasm_api.c -o static/wasm/go_model.mjs \
    -lm \
    --no-entry \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME=createGoModel \
    -s ENVIRONMENT=web,worker,node \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS='["_bf_init","_bf_step","_bf_positions","_bf_residue_count","_bf_native_fraction","_bf_radius_of_gyration","_bf_total_steps","_bf_free","_bf_forces","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPF32","HEAPF64","HEAP32"]'
  echo "    static/wasm/go_model.mjs  $(du -h static/wasm/go_model.wasm | cut -f1) wasm"
}

case "$target" in
  cli) build_cli ;;
  module) build_module ;;
  all) build_cli; build_module ;;
  *) echo "usage: $0 [cli|module|all]" >&2; exit 2 ;;
esac
