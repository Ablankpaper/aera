#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(uname -s)" = "Darwin" ] || { echo "此采集器只支持 macOS" >&2; exit 2; }

if [ "${1:-}" = "--self-test" ]; then
  [ "$#" -eq 1 ] || { echo "--self-test 不接受其他参数" >&2; exit 2; }
  [ -f "$SCRIPT_DIR/SHASUMS.txt" ] || { echo "采集器校验清单缺失" >&2; exit 1; }
  (
    cd "$SCRIPT_DIR"
    shasum -a 256 -c SHASUMS.txt >/dev/null
  ) || { echo "采集器完整性校验失败" >&2; exit 1; }
  echo "Aera macOS 采集器自检通过"
  exit 0
fi

app_path=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "--app" ]; then app_path="$arg"; fi
  previous="$arg"
done
[ -n "$app_path" ] || { echo "请提供 --app /Applications/Aera.app" >&2; exit 2; }

if [ -d "$app_path/Contents/MacOS" ]; then
  app_executable=""
  for candidate in "$app_path/Contents/MacOS"/*; do
    if [ -x "$candidate" ]; then app_executable="$candidate"; break; fi
  done
else
  app_executable="$app_path"
fi
[ -x "$app_executable" ] || { echo "找不到可执行的 Aera Electron 文件" >&2; exit 2; }

# Use the signed Electron runtime shipped inside Aera. The environment is
# scoped to this child only; no global Node.js installation is required.
exec env -u ELECTRON_RUN_AS_NODE ELECTRON_RUN_AS_NODE=1 \
  "$app_executable" "$SCRIPT_DIR/aera-diagnostic.mjs" --platform macos "$@"
