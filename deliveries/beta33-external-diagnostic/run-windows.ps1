Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$appIndex = [Array]::IndexOf($args, "-App")
if ($appIndex -lt 0) { $appIndex = [Array]::IndexOf($args, "--app") }
if ($appIndex -lt 0 -or $appIndex + 1 -ge $args.Count) {
  throw "请提供 -App C:\Program Files\Aera\Aera.exe"
}
$appPath = [string]$args[$appIndex + 1]
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "找不到 Aera 可执行文件" }

$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  & $appPath (Join-Path $scriptDir "aera-diagnostic.mjs") --platform windows @args
  exit $LASTEXITCODE
} finally {
  if ($null -eq $oldRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
  else { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
}
