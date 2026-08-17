param(
  [Parameter(Mandatory = $true)]
  [string]$App,
  [string]$Target,
  [string]$Output,
  [string]$HermesHome,
  [string]$UserData,
  [ValidateSet("external", "internal")]
  [string]$Mode = "external",
  [ValidateRange(10, 1800)]
  [int]$TimeoutSeconds = 900,
  [switch]$NoLaunch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [switch]$MustExist
  )
  try {
    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Value)
  } catch {
    $resolved = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Value))
  }
  if (-not [System.IO.Path]::IsPathRooted($resolved)) {
    throw "路径必须是绝对路径: $Value"
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $resolved)) {
    throw "路径不存在: $resolved"
  }
  return $resolved
}

$appPath = Resolve-AbsolutePath -Value $App -MustExist
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
  throw "找不到 Aera 可执行文件: $appPath"
}

$collectorScript = Join-Path $scriptDir "aera-diagnostic.mjs"
$collectorArgs = @("--platform", "windows", "--app", $appPath, "--mode", $Mode, "--timeout-seconds", [string]$TimeoutSeconds)
if ($Target) {
  $collectorArgs += @("--target", (Resolve-AbsolutePath -Value $Target -MustExist))
}
if ($Output) {
  $collectorArgs += @("--output", (Resolve-AbsolutePath -Value $Output))
}
if ($HermesHome) {
  $collectorArgs += @("--hermes-home", (Resolve-AbsolutePath -Value $HermesHome))
}
if ($UserData) {
  $collectorArgs += @("--user-data", (Resolve-AbsolutePath -Value $UserData))
}
if ($NoLaunch) { $collectorArgs += "--no-launch" }

$hadRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$exitCode = 1
try {
  $env:ELECTRON_RUN_AS_NODE = "1"
  & $appPath $collectorScript @collectorArgs
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
} finally {
  if ($hadRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $oldRunAsNode }
  else { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
}
exit $exitCode
