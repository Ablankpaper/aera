#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ "$(uname -s)" = "Darwin" ] || { echo "此采集器只支持 macOS" >&2; exit 2; }

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
