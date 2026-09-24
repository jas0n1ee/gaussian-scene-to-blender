#!/usr/bin/env bash
set -euo pipefail

builder_root="${HOME}/.cache/3dgs-web-review/spark"
if [[ ! -d "${builder_root}/.git" ]]; then
  mkdir -p "$(dirname "${builder_root}")"
  git clone --depth 1 --branch v2.2.0 https://github.com/sparkjsdev/spark.git "${builder_root}"
fi
cd "${builder_root}/rust"
cargo build --release --bin build-lod
printf 'Spark LoD builder: %s\n' "${builder_root}/rust/target/release/build-lod"
